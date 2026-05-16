import { createBuffer, type Buffer } from "../runtime/buffer";

/**
 * Third-person orbit camera. Source-of-truth state is the camera-to-target offset
 * as a world-space vector; user look-delta rotates the offset around `up` (yaw)
 * and around `side = cross(up, offset)` (pitch). No accumulated yaw/pitch scalars
 * with a fixed reference axis — that produces a singularity when `up` aligns with
 * the reference. By persisting only the offset, the camera frame is always well-
 * defined and parallel-transport becomes unnecessary; `up` is a point-wise lookup
 * (gravity-up at the target) used only by `lookAt` to set roll.
 *
 *   pos      — world position; derived as `target + offset` each tick.
 *   target   — pivot point the camera orbits (player position).
 *   up       — local up direction (gravity-up at the target by default).
 *   offset   — persistent camera-to-target offset vector (world space).
 *   fwd      — derived this tick: `-normalize(offset projected ⊥ up)`. Published
 *              for gameplay consumers (tangentInputMapperSystem) so player input
 *              tracks the visible camera frame.
 *   yaw/pitch — DERIVED outputs for back-compat readers (minimap player arrow).
 *              `yaw = atan2(-offset.x, -offset.z)` (world XZ angle of camera fwd);
 *              `pitch = asin(-offset_unit · up)`. Not state; rebuilt each tick.
 *
 * RenderSystem applies `camera.up.set(up); camera.position.set(pos); camera.lookAt(target)`.
 */
export interface CameraBufferData {
  pos: [number, number, number];
  /** Derived (read-only) output: world-Y yaw of camera-forward. Updated each tick from offset. */
  yaw: number;
  /** Derived (read-only) output: elevation above horizon. Updated each tick from offset. */
  pitch: number;
  /** Pivot point of the orbit (typically the player position). */
  target: [number, number, number];
  /** Local up direction the camera's "head" stays aligned with (gravity-up by default). */
  up: [number, number, number];
  /**
   * Persistent camera-to-target offset vector (world space). The camera lives at
   * `target + offset`. User look-delta rotates this around `up` (yaw) and around
   * `side = cross(up, offset)` (pitch). Initial offset = (0, 2.6, 6.5) — above
   * and behind the player along world +Z, looking down -Z.
   */
  offset: [number, number, number];
  /**
   * Camera's world-space forward direction, in the `up`-tangent plane. Derived
   * each tick from offset; read by tangentInputMapperSystem to drive surface
   * input projection.
   */
  fwd: [number, number, number];
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
      pitch: 0.35,
      target: [0, 0, 0],
      up: [0, 1, 0],
      // Camera sits at world (target + offset). Default: 6.5m behind in +Z and
      // 2.6m above in +Y → camera looks down ≈ -Z with a slight downward tilt.
      offset: [0, 2.6, 6.5],
      fwd: [0, 0, -1],
      fov: 70,
      aspect: 1,
      near: 0.1,
      far: 800,
    },
  });
}
