import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

export interface ForceComponent {
  /** Accumulated acceleration in world space (m/s²) for this tick. Cleared after integration. */
  accel: [number, number, number];
}

export interface ForceAccumulatorBufferData {
  byEntity: Map<EntityId, ForceComponent>;
}

export const FORCE_ACCUMULATOR_BUFFER_ID = "forceAccumulator";

export function createForceAccumulatorBuffer(): Buffer<ForceAccumulatorBufferData> {
  return createBuffer<ForceAccumulatorBufferData>({
    id: FORCE_ACCUMULATOR_BUFFER_ID,
    description:
      "Per-entity acceleration accumulator. Force fields + controllers add into it; VelocityIntegrationSystem applies and clears each tick.",
    initial: { byEntity: new Map() },
  });
}
