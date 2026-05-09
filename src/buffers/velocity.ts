import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

export interface VelocityComponent {
  /** World-space linear velocity, m/s. */
  linear: [number, number, number];
}

export interface VelocityBufferData {
  byEntity: Map<EntityId, VelocityComponent>;
}

export const VELOCITY_BUFFER_ID = "velocity";

export function createVelocityBuffer(): Buffer<VelocityBufferData> {
  return createBuffer<VelocityBufferData>({
    id: VELOCITY_BUFFER_ID,
    description: "Per-entity world-space linear velocity (m/s). VelocityIntegrationSystem updates Transform from this each tick.",
    initial: { byEntity: new Map() },
  });
}
