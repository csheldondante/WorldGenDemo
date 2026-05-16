import { createBuffer, type Buffer } from "../runtime/buffer";

export interface CameraBufferData {
  pos: [number, number, number];
  /** Yaw around gravity-up (radians). 0 = camera-forward aligned with reference forward in the
   *  gravity-tangent plane. cameraFollowSystem rotates this in response to look-delta input. */
  yaw: number;
  /** Pitch around the camera's local right axis (radians). */
  pitch: number;
  /**
   * Full camera orientation as a unit quaternion [x, y, z, w]. RenderSystem uses this
   * directly (no Euler reconstruction) so the camera follows the gravity-up frame on
   * curved gravity scenes (radial gravity volumes, etc) where world-Y is not "up."
   * cameraFollowSystem writes this from gravity-up + yaw + pitch each tick.
   */
  quaternion: [number, number, number, number];
  fov: number;   // degrees
  aspect: number;
  near: number;
  far: number;
}

export const CAMERA_BUFFER_ID = "camera";

export function createCameraBuffer(): Buffer<CameraBufferData> {
  return createBuffer<CameraBufferData>({
    id: CAMERA_BUFFER_ID,
    description: "Source-of-truth camera state. Carries pos + quaternion (built from gravity-up by cameraFollow). RenderSystem mirrors this into THREE.PerspectiveCamera each frame.",
    initial: { pos: [0, 8, 60], yaw: 0, pitch: 0, quaternion: [0, 0, 0, 1], fov: 70, aspect: 1, near: 0.1, far: 800 },
  });
}
