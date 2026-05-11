import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

export interface VelocityComponent {
  /** World-space linear velocity, m/s. */
  linear: [number, number, number];
  /**
   * Velocity at the start of this tick, snapshotted before any integration or
   * surface-constraint modifications. Lets downstream systems derive the
   * effective per-tick acceleration as `(linear - prevLinear) / dt`. Stored
   * on the buffer (not in a closure) so animation/diagnostic systems can
   * consume it without owning their own caching policy.
   */
  prevLinear: [number, number, number];
}

export interface VelocityBufferData {
  byEntity: Map<EntityId, VelocityComponent>;
}

export const VELOCITY_BUFFER_ID = "velocity";

export function createVelocityBuffer(): Buffer<VelocityBufferData> {
  return createBuffer<VelocityBufferData>({
    id: VELOCITY_BUFFER_ID,
    description:
      "Per-entity world-space linear velocity (m/s). VelocityIntegrationSystem updates Transform from this each tick; snapshots prev value at the start of integration so downstream systems can derive per-tick acceleration.",
    initial: { byEntity: new Map() },
  });
}
