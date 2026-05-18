import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

/**
 * Per-entity collider shape for broadphase + narrowphase collision detection.
 *
 * Independent of SphereBodyBuffer (which is the character's visual+physics
 * sphere); a collider attaches a collision shape that may differ from the
 * visual primitive — e.g. a level obstacle has an AABB collider but no
 * sphere body. Centred at `Transform.position` by default.
 *
 * Shape union: keep it small for the prototype.
 *   - sphere: bounded by `radius`.
 *   - aabb: bounded by `halfExtents` along world X/Y/Z.
 *
 * `isStatic` is a hint to the broadphase: static endpoints are not re-sorted
 * each tick, which is the main perf win for level geometry.
 */
export type ColliderShape =
  | { type: "sphere"; radius: number }
  | { type: "aabb"; halfExtents: [number, number, number] };

export interface ColliderComponent {
  shape: ColliderShape;
  isStatic: boolean;
}

export interface ColliderBufferData {
  byEntity: Map<EntityId, ColliderComponent>;
}

export const COLLIDER_BUFFER_ID = "collider";

export function createColliderBuffer(): Buffer<ColliderBufferData> {
  return createBuffer<ColliderBufferData>({
    id: COLLIDER_BUFFER_ID,
    description:
      "Per-entity collider shape (sphere or AABB) for the broadphase/narrowphase collision pipeline. Static colliders (level geometry) are flagged so the SAP skips them in per-tick endpoint re-sorting.",
    initial: { byEntity: new Map() },
  });
}
