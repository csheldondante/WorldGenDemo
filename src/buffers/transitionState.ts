import { createBuffer, type Buffer } from "../runtime/buffer";

/**
 * Tracks the in-flight transition (if any). When `activeTransitionId`
 * is non-null, the runtime loop executes that transition's `systems`
 * each tick instead of the active mode's; on the tick the transition's
 * `isComplete(reg)` returns true, the loop clears this buffer and
 * advances `activeMode` to the transition's `to` field.
 *
 * Phase 3b of the modes-and-modules refactor. Per user 2026-05-23:
 * the Rebuilding pipeline (bitmap + sceneJSON → 3D scene) is the
 * canonical transition — it consumes one buffer representation and
 * produces another. Register it in src/app/transitions.ts.
 */
export interface TransitionStateBufferData {
  activeTransitionId: string | null;
  /** Tick index when the transition started (= for timing / debug).
   *  Set by the loop on activation; read by the LibraryViewer + debug
   *  consumers. */
  startedTick: number;
}

export const TRANSITION_STATE_BUFFER_ID = "transitionState";

export function createTransitionStateBuffer(): Buffer<TransitionStateBufferData> {
  return createBuffer<TransitionStateBufferData>({
    id: TRANSITION_STATE_BUFFER_ID,
    description:
      "In-flight transition tracker. activeTransitionId is non-null while a registered Transition is running between modes; the loop runs the transition's systems until isComplete(reg) returns true, then clears the buffer and advances activeMode to the transition's `to` mode.",
    initial: { activeTransitionId: null, startedTick: 0 },
  });
}
