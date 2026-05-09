import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";
import type { SurfaceId, SurfaceSample } from "../world/surfaceProvider";

export interface SurfaceAttachmentComponent {
  surfaceId: SurfaceId;
  /** UV coordinates on the surface, in [0, 1]². */
  uv: [number, number];
  /** World-space offset along the surface normal (≥0). */
  offsetAlongNormal: number;
  /** Cached sample at the current UV; refreshed each tick by SurfaceConstraintSystem. */
  sample: SurfaceSample | null;
}

export interface SurfaceAttachmentBufferData {
  byEntity: Map<EntityId, SurfaceAttachmentComponent>;
}

export const SURFACE_ATTACHMENT_BUFFER_ID = "surfaceAttachment";

export function createSurfaceAttachmentBuffer(): Buffer<SurfaceAttachmentBufferData> {
  return createBuffer<SurfaceAttachmentBufferData>({
    id: SURFACE_ATTACHMENT_BUFFER_ID,
    description:
      "Per-entity surface-constraint state: which surface, UV on it, offset along normal, cached sample. Maintained by SurfaceConstraintSystem when CharacterController.locomotionMode is surfaceConstrained.",
    initial: { byEntity: new Map() },
  });
}
