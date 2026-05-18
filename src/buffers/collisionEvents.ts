import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

/**
 * Per-tick collision events. Produced by NarrowphaseSystem (and the airborne
 * surface-sweep integrator); consumed by CollisionResolutionSystem and any
 * downstream listener (audio impact sounds, damage, etc.).
 *
 * Each event describes a single contact:
 *   - `a`, `b`: the colliding entities. Convention: if `b === null`, the
 *     contact is against the world surface (heightmap) — there's no second
 *     entity, and `normal` points from the surface outward.
 *   - `normal`: unit outward normal at the contact, pointing AWAY from `b`
 *     (or away from the surface when `b === null`).
 *   - `depth`: penetration depth along `normal`. Always ≥ 0.
 *   - `point`: world-space contact point (centre of overlap region).
 *
 * Cleared at the start of each broadphase tick; events are valid only for
 * the current tick.
 */
export interface CollisionEvent {
  a: EntityId;
  b: EntityId | null;
  normal: [number, number, number];
  depth: number;
  point: [number, number, number];
}

export interface CollisionEventsBufferData {
  events: CollisionEvent[];
}

export const COLLISION_EVENTS_BUFFER_ID = "collisionEvents";

export function createCollisionEventsBuffer(): Buffer<CollisionEventsBufferData> {
  return createBuffer<CollisionEventsBufferData>({
    id: COLLISION_EVENTS_BUFFER_ID,
    description:
      "Per-tick collision events: {a, b, normal, depth, point}. b=null indicates a surface (heightmap) contact. Produced by NarrowphaseSystem; consumed by collision resolution + downstream listeners.",
    initial: { events: [] },
  });
}
