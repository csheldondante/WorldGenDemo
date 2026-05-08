import { Fsm } from "../lib/stateMachine";
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

export type RuntimeState = "Running" | "Rebuilding";

export type RuntimeEvent =
  | {
      type: "RebuildRequested";
      payload:
        | { kind: "byName"; name: string }
        | {
            kind: "fromBitmap";
            pixels: Uint8ClampedArray;
            width: number;
            height: number;
            scene: import("../core/types").SceneFile;
          };
    }
  | { type: "WorldReady" };

export interface StateMachineBufferData {
  state: RuntimeState;
  activeGraph: GraphId;
  /** Events that triggered the current tick's transitions. Read-only for downstream systems. */
  pendingEvents: RuntimeEvent[];
}

export const STATE_MACHINE_SYSTEM_ID = "stateMachineSystem";
export const STATE_MACHINE_BUFFER_ID = "stateMachine";
export const EVENT_BUFFER_ID = "events";

/**
 * Build a fresh Fsm wired with the V0 transitions. Exported so tests / tools
 * can inspect the machine independent of the system wrapper.
 */
export function buildRuntimeFsm(initial: RuntimeState = "Running"): Fsm<RuntimeState, RuntimeEvent> {
  const fsm = new Fsm<RuntimeState, RuntimeEvent>(initial, { historyLimit: 32 });
  fsm.addTransition({ from: "Running", on: "RebuildRequested", to: "Rebuilding" });
  fsm.addTransition({ from: "Rebuilding", on: "WorldReady", to: "Running" });
  return fsm;
}

const STATE_TO_GRAPH: Record<RuntimeState, GraphId> = {
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
      for (const ev of drained) {
        fsm.dispatch(ev);
      }
      const newState = fsm.state;
      writeBuffer(sm, (d) => {
        d.state = newState;
        d.activeGraph = STATE_TO_GRAPH[newState];
      });
    },
  };
}
