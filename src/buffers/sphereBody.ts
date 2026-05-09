import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

export interface SphereBodyComponent {
  /** World-space radius. */
  radius: number;
}

export interface SphereBodyBufferData {
  byEntity: Map<EntityId, SphereBodyComponent>;
}

export const SPHERE_BODY_BUFFER_ID = "sphereBody";

export function createSphereBodyBuffer(): Buffer<SphereBodyBufferData> {
  return createBuffer<SphereBodyBufferData>({
    id: SPHERE_BODY_BUFFER_ID,
    description:
      "Sphere collision/visual primitive. The character is a sphere; future bodies (capsule etc) get their own buffers.",
    initial: { byEntity: new Map() },
  });
}
