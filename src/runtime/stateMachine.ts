import { Fsm } from "../lib/stateMachine";
import { warnDev } from "./dev";
import { readBuffer, writeBuffer } from "./buffer";
import type { GraphId, SystemDescriptor } from "./system";

/**
 * Runtime state machine: drives `activeGraph` selection from events.
 *
 * V0 states:
 *   Running    — per-frame loop active (Running graph)
 *   Rebuilding — pipeline runs once (Rebuilding graph)
 *
 * On the first tick, `world.ts` writes a `RebuildRequested` into EventBuffer
 * to bootstrap initial scene load — no separate "Loading" state.
 */

export type RuntimeState = "Startup" | "Loading" | "Rebuilding" | "Running" | "Builder";

/** Mode payload — extend if more modes ship. */
export type RuntimeMode = "world" | "builder";

export interface RebuildPayload {
  /** Display name for the HUD; not used by the pipeline. */
  sceneName: string;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  scene: import("../core/types").SceneFile;
  /** The original PNG, kept so the minimap can render it. */
  image: HTMLImageElement;
}

export type RuntimeEvent =
  | { type: "LoadRequested"; payload: { sceneName: string } }
  | { type: "RebuildRequested"; payload: RebuildPayload }
  | { type: "WorldReady" }
  | { type: "ModeRequested"; payload: { mode: RuntimeMode } }
  /** Generic mode-switch request — overrides `activeMode` directly
   *  without touching the SM's `state`. Used by the inspector
   *  overlay and any transient mode swap that doesn't fit the
   *  original FSM. Tech-debt payoff 2026-05-23 (= replaces direct
   *  `activeMode` mutation from DOM event handlers). */
  | { type: "ModeSwitchRequested"; payload: { modeId: string } }
  /** Generic binding-swap request — `BindingSwapSystem` drains
   *  these and calls `applyControllerBinding`. Replaces direct
   *  imperative calls from the binding-picker UI. */
  | { type: "BindingRequested"; payload: { bindingId: string } }
  /** Emitted by the SM on every mode transition. Setup systems read
   *  this to perform one-time mode-activation work. See
   *  `docs/modes-and-modules.md` for the event-driven mode-lifecycle
   *  pattern. */
  | { type: "ModeEntered"; payload: { modeId: string } }
  /** Emitted alongside ModeEntered. Teardown systems read this to
   *  clean up owned buffers / cancel pending work. */
  | { type: "ModeExited"; payload: { modeId: string } };

export interface StateMachineBufferData {
  state: RuntimeState;
  activeGraph: GraphId;
  /**
   * Canonical mode id for the modes-and-modules architecture (= the
   * loop's source of truth for which graph to execute). Phase 1b: this
   * field mirrors `activeGraph` (= same string for the 4 core modes).
   * The loop reads `activeMode` and looks up the mode's `systems` via
   * the registry to derive the graph; `activeGraph` remains during the
   * transition window for backward compatibility. See
   * `docs/modes-and-modules.md`.
   */
  activeMode: string;
  /**
   * Events that triggered the current tick's transitions. Read-only for
   * downstream systems within the same tick.
   */
  pendingEvents: RuntimeEvent[];
  /**
   * Scene to load. Set when entering Loading; consumed by LoadSceneSystem;
   * cleared when transitioning out of Loading.
   */
  pendingLoad: { sceneName: string } | null;
  /**
   * Rebuild payload that survives across ticks until the rebuild completes.
   * Set when entering Rebuilding; read by pipeline stages; cleared when
   * returning to Running.
   */
  pendingRebuild: RebuildPayload | null;
  /**
   * Monotonically-increasing counter, bumped each time SM enters Rebuilding.
   * Pipeline systems use this to fire exactly once per rebuild via a closure.
   */
  rebuildGeneration: number;
}

export const STATE_MACHINE_SYSTEM_ID = "stateMachineSystem";
export const STATE_MACHINE_BUFFER_ID = "stateMachine";
export const EVENT_BUFFER_ID = "events";

/**
 * Build a fresh Fsm wired with the V0 transitions. Exported so tests / tools
 * can inspect the machine independent of the system wrapper.
 */
export function buildRuntimeFsm(initial: RuntimeState = "Startup"): Fsm<RuntimeState, RuntimeEvent> {
  const fsm = new Fsm<RuntimeState, RuntimeEvent>(initial, {
    historyLimit: 32,
    onUnhandled: ({ reason, event, state }) => {
      // unmatched: event has no rule for this state — usually a bug
      // self-transition: rule matched but to===from — sometimes valid
      // (e.g. re-issuing LoadRequested for the same scene). Logged at warn level.
      warnDev(`SM ${reason}: event="${event.type}" from state="${state}"`);
    },
  });
  // Boot path: Startup → Loading → Rebuilding → Running
  fsm.addTransition({ from: "Startup", on: "LoadRequested", to: "Loading" });
  fsm.addTransition({ from: "Loading", on: "RebuildRequested", to: "Rebuilding" });
  fsm.addTransition({ from: "Rebuilding", on: "WorldReady", to: "Running" });
  // Re-load while running (e.g. user types ?map= and reloads, or future UI hook)
  fsm.addTransition({ from: "Running", on: "LoadRequested", to: "Loading" });
  // Re-build while running (e.g. painter sends edits)
  fsm.addTransition({ from: "Running", on: "RebuildRequested", to: "Rebuilding" });
  // Mode swap to/from Builder
  fsm.addTransition({
    from: "Running",
    on: "ModeRequested",
    to: "Builder",
    guard: (ev) => ev.type === "ModeRequested" && ev.payload.mode === "builder",
  });
  fsm.addTransition({
    from: "Builder",
    on: "ModeRequested",
    to: "Running",
    guard: (ev) => ev.type === "ModeRequested" && ev.payload.mode === "world",
  });
  // Builder can request a rebuild (Send-to-World)
  fsm.addTransition({ from: "Builder", on: "RebuildRequested", to: "Rebuilding" });
  return fsm;
}

/**
 * Map runtime state → graph id. Startup shares the Loading graph; the systems
 * in that graph (LoadScene, etc.) gate on the SM state internally and become
 * no-ops outside their owning state.
 */
const STATE_TO_GRAPH: Record<RuntimeState, GraphId> = {
  Startup: "Loading",
  Loading: "Loading",
  Running: "Running",
  Rebuilding: "Rebuilding",
  Builder: "Builder",
};

export function createStateMachineSystem(): SystemDescriptor {
  // FSM is created lazily on first execute() so that re-creating the system
  // for tests (with a fresh registry) starts from the right buffer state.
  let fsm: Fsm<RuntimeState, RuntimeEvent> | null = null;

  return {
    id: STATE_MACHINE_SYSTEM_ID,
    description: "Runtime state machine: drives activeGraph from EventBuffer.",
    buffers: [
      { id: EVENT_BUFFER_ID, access: "readwrite" }, // drained
      { id: STATE_MACHINE_BUFFER_ID, access: "readwrite" },
    ],
    execute: ({ buffer }) => {
      const sm = buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
      const events = buffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
      if (!fsm) fsm = buildRuntimeFsm(readBuffer(sm).state);

      const incoming = readBuffer(events);
      const drained = incoming.slice(); // FIFO snapshot
      // Preserve events the SM doesn't consume so downstream systems
      // (BindingSwapSystem etc.) can read them this same tick. The SM
      // owns LoadRequested / RebuildRequested / WorldReady /
      // ModeRequested / ModeSwitchRequested. Lifecycle events
      // (ModeEntered / ModeExited) are emitted by the SM at the end of
      // execute — they don't need to be carried over.
      const SM_CONSUMED = new Set<RuntimeEvent["type"]>([
        "LoadRequested",
        "RebuildRequested",
        "WorldReady",
        "ModeRequested",
        "ModeSwitchRequested",
        // Lifecycle events are emitted by the SM at end-of-execute and
        // intended for THIS tick's downstream consumers. The SM
        // drains them on the next tick so they don't accumulate in
        // the event buffer indefinitely (= each lifecycle event lives
        // for at most one tick of unobserved bookkeeping).
        "ModeEntered",
        "ModeExited",
      ]);
      const passthrough = drained.filter((ev) => !SM_CONSUMED.has(ev.type));
      writeBuffer(events, () => passthrough);

      writeBuffer(sm, (d) => {
        d.pendingEvents = drained;
      });
      let newPendingRebuild: RebuildPayload | null = readBuffer(sm).pendingRebuild;
      let newPendingLoad: { sceneName: string } | null = readBuffer(sm).pendingLoad;
      let bumpGeneration = false;
      // Handle ModeSwitchRequested events independently of the FSM —
      // they override `activeMode` without touching `state`. Tracked
      // in lastModeSwitchTarget so the post-FSM block can apply it.
      let lastModeSwitchTarget: string | null = null;
      for (const ev of drained) {
        if (ev.type === "ModeSwitchRequested") {
          lastModeSwitchTarget = ev.payload.modeId;
          continue;
        }
        // Lifecycle events are for external consumers; the SM emits
        // them but does not process them as transitions. Skip the
        // FSM dispatch to avoid noisy onUnhandled warnings.
        if (ev.type === "ModeEntered" || ev.type === "ModeExited") continue;
        // BindingRequested is consumed by BindingSwapSystem — not an
        // SM transition. Skip dispatch (BindingSwapSystem reads from
        // a fresh read of the event buffer; the SM drained then
        // re-appended below for downstream consumers).
        if (ev.type === "BindingRequested") continue;
        const prev = fsm.state;
        const r = fsm.dispatch(ev); // onUnhandled inside the FSM logs unmatched/self
        if (!r.transitioned) continue;
        // Capture payload on actual transition. With the Startup → Loading →
        // Rebuilding → Running shape there are no self-transition traps for
        // these payload-bearing events.
        if (ev.type === "LoadRequested" && fsm.state === "Loading") {
          newPendingLoad = ev.payload;
        }
        if (ev.type === "RebuildRequested" && fsm.state === "Rebuilding") {
          newPendingRebuild = ev.payload;
          bumpGeneration = true;
        }
        if (prev === "Rebuilding" && fsm.state !== "Rebuilding") {
          newPendingRebuild = null;
        }
        if (prev === "Loading" && fsm.state !== "Loading") {
          newPendingLoad = null;
        }
      }
      const newState = fsm.state;
      const prevState = readBuffer(sm).state;
      const prevActiveMode = readBuffer(sm).activeMode;
      const stateChanged = newState !== prevState;
      // Compute the next activeMode:
      //   - If a ModeSwitchRequested event arrived this tick, its
      //     payload wins (= UI / scripted override).
      //   - Else if the FSM state changed, sync activeMode to the
      //     new state's graph.
      //   - Else if the current activeMode is one of the 4 core
      //     graph ids, auto-sync it to STATE_TO_GRAPH[newState]
      //     (= original pre-payoff behavior — heals drift from
      //     direct seedPlayerOnSurface mutations etc.).
      //   - Else leave activeMode as it was (= preserves
      //     non-core overrides like "LibraryViewer", scene modes
      //     across ticks).
      const CORE_GRAPH_IDS = new Set(Object.values(STATE_TO_GRAPH));
      let nextMode = prevActiveMode;
      if (lastModeSwitchTarget !== null) nextMode = lastModeSwitchTarget;
      else if (stateChanged) nextMode = STATE_TO_GRAPH[newState];
      else if (CORE_GRAPH_IDS.has(prevActiveMode)) nextMode = STATE_TO_GRAPH[newState];
      writeBuffer(sm, (d) => {
        d.state = newState;
        d.activeGraph = STATE_TO_GRAPH[newState];
        d.activeMode = nextMode;
        d.pendingRebuild = newPendingRebuild;
        d.pendingLoad = newPendingLoad;
        if (bumpGeneration) d.rebuildGeneration += 1;
      });
      // Emit mode-lifecycle events whenever the active MODE changes,
      // whether driven by FSM state change or by ModeSwitchRequested.
      // Setup/teardown systems consume these via the event buffer —
      // see docs/modes-and-modules.md. The SM itself skips dispatch
      // on these event types (see the `continue` in the event loop
      // above) so re-reading them on the next tick is a no-op without
      // unmatched-event warnings.
      if (nextMode !== prevActiveMode) {
        writeBuffer(events, (d) => {
          d.push({ type: "ModeExited", payload: { modeId: prevActiveMode } });
          d.push({ type: "ModeEntered", payload: { modeId: nextMode } });
        });
      }
    },
  };
}
