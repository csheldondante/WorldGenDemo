import { createBuffer, type Buffer } from "../runtime/buffer";

/**
 * Spherical third-person camera state. The camera orbits the `target` point on a
 * sphere of fixed radius (FOLLOW_DISTANCE inside cameraFollowSystem), parameterized
 * around the `up` axis:
 *
 *   yaw   — azimuth (θ) around `up`; rotates the camera around the player.
 *   pitch — elevation (φ) above the orbit horizon; 0 = level with the player, +π/2 = directly above.
 *
 * Pitch is clamped to slightly less than π/2 so the camera never reaches the
 * "poles" of the orbit sphere. Radius is constant; yaw never changes distance.
 *
 * RenderSystem applies this as `camera.up.set(up); camera.position.set(pos); camera.lookAt(target)`.
 */
export interface CameraBufferData {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  /** Pivot point of the orbit (typically the player position). */
  target: [number, number, number];
  /** Local up direction the camera's "head" stays aligned with (gravity-up by default). */
  up: [number, number, number];
  fov: number;
  aspect: number;
  near: number;
  far: number;
}

export const CAMERA_BUFFER_ID = "camera";

export function createCameraBuffer(): Buffer<CameraBufferData> {
  return createBuffer<CameraBufferData>({
    id: CAMERA_BUFFER_ID,
    description:
      "Source-of-truth camera state. Spherical orbit around target with up = gravity-up. RenderSystem applies via THREE.Camera.up + lookAt(target).",
    initial: {
      pos: [0, 8, 60],
      yaw: 0,
      pitch: 0.35, // ~20° above horizon by default — camera starts above the player
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: 70,
      aspect: 1,
      near: 0.1,
      far: 800,
    },
  });
}
