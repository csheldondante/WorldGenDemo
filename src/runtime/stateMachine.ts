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

export type RuntimeState = "Startup" | "Loading" | "Rebuilding" | "Running";

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
  | { type: "WorldReady" };

export interface StateMachineBufferData {
  state: RuntimeState;
  activeGraph: GraphId;
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
      writeBuffer(events, () => []);

      writeBuffer(sm, (d) => {
        d.pendingEvents = drained;
      });
      let newPendingRebuild: RebuildPayload | null = readBuffer(sm).pendingRebuild;
      let newPendingLoad: { sceneName: string } | null = readBuffer(sm).pendingLoad;
      let bumpGeneration = false;
      for (const ev of drained) {
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
      writeBuffer(sm, (d) => {
        d.state = newState;
        d.activeGraph = STATE_TO_GRAPH[newState];
        d.pendingRebuild = newPendingRebuild;
        d.pendingLoad = newPendingLoad;
        if (bumpGeneration) d.rebuildGeneration += 1;
      });
    },
  };
}
