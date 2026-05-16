import { createBuffer, type Buffer } from "../runtime/buffer";

export interface CameraBufferData {
  pos: [number, number, number];
  yaw: number;   // radians, around +Y, 0 = looking down -Z
  pitch: number; // radians, around camera-local +X
  fov: number;   // degrees
  aspect: number;
  near: number;
  far: number;
}

export const CAMERA_BUFFER_ID = "camera";

export function createCameraBuffer(): Buffer<CameraBufferData> {
  return createBuffer<CameraBufferData>({
    id: CAMERA_BUFFER_ID,
    description: "Source-of-truth camera state. RenderSystem mirrors this into THREE.PerspectiveCamera each frame.",
    initial: { pos: [0, 8, 60], yaw: 0, pitch: 0, fov: 70, aspect: 1, near: 0.1, far: 800 },
  });
}
