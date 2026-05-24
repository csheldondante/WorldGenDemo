/**
 * TransitionActivatorSystem — bridges the SM state machine to the
 * TransitionStateBuffer. When the SM enters a state that corresponds
 * to an in-flight transition, this system writes the transition's id
 * into TransitionStateBuffer; the runtime loop then runs the
 * transition's systems until `isComplete(reg)` returns true.
 *
 * Today's mapping: SM state === "Rebuilding" → activeTransitionId =
 * "RebuildingToRunning". When SM exits Rebuilding (= moves to Running
 * via WorldReady), the loop's isComplete check clears the buffer.
 *
 * The state→transition mapping lives here (in src/app/) rather than
 * in the SM (src/runtime/) because the SM is feature-agnostic — it
 * doesn't know which mode transitions correspond to which application
 * Transitions. The mapping IS application-specific.
 */

import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { Registry } from "../runtime/registry";
import type { SystemDescriptor } from "../runtime/system";
import {
  STATE_MACHINE_BUFFER_ID,
  STATE_MACHINE_SYSTEM_ID,
  type StateMachineBufferData,
} from "../runtime/stateMachine";
import {
  TRANSITION_STATE_BUFFER_ID,
  type TransitionStateBufferData,
} from "../buffers/transitionState";
import { REBUILDING_TRANSITION_ID } from "./transitions";

export const TRANSITION_ACTIVATOR_SYSTEM_ID = "transitionActivatorSystem";

/** SM state id → transition id mapping. Update when new state-to-
 *  transition relationships are introduced. */
const STATE_TO_TRANSITION: Record<string, string> = {
  Rebuilding: REBUILDING_TRANSITION_ID,
};

export function createTransitionActivatorSystem(): SystemDescriptor {
  let lastState: string | null = null;
  return {
    id: TRANSITION_ACTIVATOR_SYSTEM_ID,
    description:
      "Observes SM state changes and writes the matching transition id into TransitionStateBuffer. When SM enters Rebuilding, activates the RebuildingToRunning transition; the loop runs the transition's systems until isComplete(reg) returns true.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: TRANSITION_STATE_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID],
    execute: ({ buffer, now }) => {
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      if (sm.state === lastState) return;
      const prevState = lastState;
      lastState = sm.state;
      const transitionId = STATE_TO_TRANSITION[sm.state];
      const ts = buffer<TransitionStateBufferData>(TRANSITION_STATE_BUFFER_ID);
      if (transitionId) {
        writeBuffer(ts, (d) => {
          if (d.activeTransitionId !== transitionId) {
            d.activeTransitionId = transitionId;
            d.startedTick = Math.round(now);
          }
        });
      } else if (prevState !== null && STATE_TO_TRANSITION[prevState]) {
        // Left a transition-bound state via some other path (= e.g.,
        // SM error recovery). Clear the activator so the loop stops
        // running the transition graph. Normal completion goes through
        // the loop's isComplete check; this is just the safety net.
        writeBuffer(ts, (d) => {
          d.activeTransitionId = null;
          d.startedTick = 0;
        });
      }
    },
  };
}

/** Convenience to register the activator into a registry. */
export function registerTransitionActivator(reg: Registry): void {
  reg.registerSystem(createTransitionActivatorSystem());
}
