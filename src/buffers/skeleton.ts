import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";
import type { RigDefinition } from "./rigDefinition";

/**
 * Per-entity skeletal pose.
 *
 * Why struct-of-bones (each BoneState is a plain object) instead of parallel
 * Float32Arrays: at ~10 bones per character, readability and per-bone-named-
 * access beat cache locality. Revisit if we ever batch hundreds of skeletons —
 * the migration target is parallel `Float32Array`s for SIMD-friendly chain
 * solvers.
 */
export interface BoneState {
  localPos: [number, number, number];
  /**
   * Local rotation as a unit quaternion. For chain-segment bones this is
   * derived each tick from `leanVec` by ChainDynamicsSystem; for non-chain
   * bones (and at bind pose) it's whatever the rig declares.
   */
  localRot: [number, number, number, number];
  /**
   * Lean rotation expressed as an axis-angle vector (`axis * angle`) in the
   * bone's parent frame. Spring dynamics integrate this directly; localRot
   * is the rendering form. Zero for non-chain bones.
   */
  leanVec: [number, number, number];
  /** Angular velocity of `leanVec` (rad/s along each axis). */
  leanVel: [number, number, number];
  /** Computed by SkeletonWorldSystem each tick from local + parent chain + entity transform. */
  worldPos: [number, number, number];
  worldRot: [number, number, number, number];
}

export interface SkeletonComponent {
  /** Resolves to a RigDefinition in RigDefinitionBuffer.byId. */
  rigId: string;
  /** Parallel to RigDefinition.bones; same length and order. */
  bones: BoneState[];
}

export interface SkeletonBufferData {
  byEntity: Map<EntityId, SkeletonComponent>;
}

export const SKELETON_BUFFER_ID = "skeleton";

export function createSkeletonBuffer(): Buffer<SkeletonBufferData> {
  return createBuffer<SkeletonBufferData>({
    id: SKELETON_BUFFER_ID,
    description:
      "Per-entity skeletal pose: bind-pose-initialized BoneState[] with current local + world transforms. Read+written by SkeletonWorldSystem (FK), later by SpineChainSystem (Phase 1B) and IKSolverSystem (Phase 1C); read by SkeletonDebugRenderSystem.",
    initial: { byEntity: new Map() },
  });
}

/**
 * Initialize a SkeletonComponent at the rig's bind pose. World transforms are
 * zeroed; the first SkeletonWorldSystem tick fills them in.
 */
export function initSkeletonFromRig(rig: RigDefinition): SkeletonComponent {
  return {
    rigId: rig.id,
    bones: rig.bones.map((b) => ({
      localPos: [b.bindLocalPos[0], b.bindLocalPos[1], b.bindLocalPos[2]],
      localRot: [b.bindLocalRot[0], b.bindLocalRot[1], b.bindLocalRot[2], b.bindLocalRot[3]],
      leanVec: [0, 0, 0],
      leanVel: [0, 0, 0],
      worldPos: [0, 0, 0],
      worldRot: [0, 0, 0, 1],
    })),
  };
}
