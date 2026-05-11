import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

/**
 * Per-foot lock state for the plant-and-step model.
 *
 * Why this lives in its own buffer instead of on `CharacterControllerComponent`
 * or inside `SkeletonBuffer.bones`: it's per-leg (not per-entity scalar) and
 * conceptually separate from both physics control and bone geometry —
 * `FootPlannerSystem` owns it, `FootIKSystem` reads it. Two responsibilities,
 * two systems, one focused buffer.
 *
 * The array index for each leg matches `RigDefinition.legs[i]`. Legs are not
 * dynamic, so once a skeleton is initialized the array length is fixed.
 */
export interface FootLockState {
  /** `"planted"` = foot is glued to `plantPos` in world space. `"swinging"` = foot is in transit from `prevPlant` to `plantTarget`. */
  state: "planted" | "swinging";
  /** Current world plant position. While planted this is the actual foot location; while swinging it tracks the lerp output (so a tick-skip never teleports the foot). */
  plantPos: [number, number, number];
  /** World position the foot left when the current swing began. */
  prevPlant: [number, number, number];
  /** World position the foot is swinging toward. */
  plantTarget: [number, number, number];
  /** Body yaw (rad) at the time this plant was recorded. Used so a turn-in-place
   *  triggers a re-plant even though the hip barely translates. */
  plantYaw: number;
  /** Normalized swing progress in [0, 1]. */
  swingT: number;
  /** Duration of the current swing (seconds); lets longer-distance swings take longer naturally. */
  swingDur: number;
  /** False until the first valid plant is recorded; first tick snaps the foot to its `hipUnder` instead of swinging through space. */
  initialized: boolean;
}

export interface FootLockBufferData {
  byEntity: Map<EntityId, FootLockState[]>;
}

export const FOOT_LOCK_BUFFER_ID = "footLock";

export function createFootLockBuffer(): Buffer<FootLockBufferData> {
  return createBuffer<FootLockBufferData>({
    id: FOOT_LOCK_BUFFER_ID,
    description:
      "Per-entity, per-leg foot-lock state machine. Each foot stays planted at a world position until the hip drifts beyond a threshold or velocity drops enough that the foot needs to move under the hip for balance — then it swings to a new plant. Written by FootPlannerSystem; read by FootIKSystem.",
    initial: { byEntity: new Map() },
  });
}

export function makeUninitializedFootLockStates(count: number): FootLockState[] {
  return Array.from({ length: count }, () => ({
    state: "planted" as const,
    plantPos: [0, 0, 0] as [number, number, number],
    prevPlant: [0, 0, 0] as [number, number, number],
    plantTarget: [0, 0, 0] as [number, number, number],
    plantYaw: 0,
    swingT: 0,
    swingDur: 0.22,
    initialized: false,
  }));
}
