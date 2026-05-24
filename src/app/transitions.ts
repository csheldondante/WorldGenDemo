/**
 * Application-level transitions. A Transition runs between two modes
 * — its `systems` list is executed each tick until `isComplete(reg)`
 * returns true, at which point `activeMode` advances to the
 * transition's `to` mode. See `docs/modes-and-modules.md`.
 *
 * Per user 2026-05-23: the Rebuilding pipeline (bitmap + sceneJSON →
 * 3D scene) is the canonical transition — it consumes one buffer
 * representation (raw image + scene file) and produces another
 * (terrain mesh, asset meshes, surface provider, player spawn). Its
 * `isComplete` rule is "WorldReady was emitted" — which today maps
 * to `SM.state === Running`.
 *
 * Activation:
 *   - When the runtime needs to transition from one mode to another
 *     and a registered Transition matches the (from, to) pair, write
 *     its id into `TransitionStateBuffer.activeTransitionId`. The
 *     loop sees the buffer and runs the transition's graph instead
 *     of the source mode's. On `isComplete`, the loop clears the
 *     buffer and advances `activeMode` to the transition's `to`.
 *
 * Today the activation for the Rebuilding flow is performed by
 * `LoadSceneSystem` when it detects a `LoadRequested` event +
 * fetches the bitmap. Once the assets are loaded, it writes the
 * `activeTransitionId = "RebuildingToRunning"` into the buffer.
 */

import type { Registry } from "../runtime/registry";
import type { Transition } from "../runtime/transition";
import { readBuffer } from "../runtime/buffer";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../runtime/stateMachine";
import { REBUILDING_GRAPH_ID, RUNNING_GRAPH_ID, LOADING_GRAPH_ID } from "./graphs";

export const REBUILDING_TRANSITION_ID = "RebuildingToRunning";

/**
 * Build the Rebuilding transition. Its `systems` field references the
 * Rebuilding mode's systems (= the existing pipeline). isComplete is
 * "SM state === Running" — the WorldReady event drives the SM state
 * change, which is the signal that the rebuild finished.
 */
export function buildRebuildingTransition(reg: Registry): Transition {
  const rebuilding = reg.getMode(REBUILDING_GRAPH_ID);
  if (!rebuilding) {
    throw new Error(
      `buildRebuildingTransition: mode '${REBUILDING_GRAPH_ID}' not registered. ` +
        `Call buildAndRegisterCoreGraphs(reg) first.`,
    );
  }
  return {
    id: REBUILDING_TRANSITION_ID,
    from: LOADING_GRAPH_ID,
    to: RUNNING_GRAPH_ID,
    systems: rebuilding.systems,
    isComplete: (r: Registry) => {
      const sm = readBuffer(r.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      return sm.state === "Running";
    },
  };
}

/**
 * Register all app-level transitions. Idempotent within a registry.
 */
export function registerTransitions(reg: Registry): void {
  reg.registerTransition(buildRebuildingTransition(reg));
}
