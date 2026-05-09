import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

export interface TransformComponent {
  position: [number, number, number];
  /** Yaw-only orientation for V1; full quaternion later. */
  yaw: number;
  scale: number;
}

export interface TransformBufferData {
  byEntity: Map<EntityId, TransformComponent>;
}

export const TRANSFORM_BUFFER_ID = "transform";

export function createTransformBuffer(): Buffer<TransformBufferData> {
  return createBuffer<TransformBufferData>({
    id: TRANSFORM_BUFFER_ID,
    description: "Per-entity world position, yaw, scale. Source of truth for character + asset placement.",
    initial: { byEntity: new Map() },
  });
}
