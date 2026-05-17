import { createBuffer, type Buffer } from "../runtime/buffer";

/**
 * Camera buffer. Three logical slices:
 *
 *  - **Renderer-facing output** (`pos`, `yaw`, `pitch`, `fov`, `aspect`,
 *    `near`, `far`) — what RenderSystem mirrors into THREE.PerspectiveCamera
 *    each frame. Source of truth for what the user sees.
 *
 *  - **Pivot** (`pivot.position`, `pivot.up`, `pivot.fwd`) — the orbit
 *    centre. CameraPivotSystem writes this from the followed character's
 *    transform + the local gravity field (Phase 2). `up` and `fwd` form a
 *    pivot-local frame so the orbit math works the same on flat ground,
 *    convex hills, or radial-gravity surfaces.
 *
 *  - **Target spherical coords** (`target.{distance, yaw, pitch, roll, fov}`)
 *    + **params** — what the camera is chasing each tick, plus the
 *    responsiveness / pitch-cushion / FOV defaults that drive the chase.
 *    CameraOrbitSystem reads `lookDelta`, updates `target.{yaw,pitch}`,
 *    interpolates toward target and writes back into the renderer-facing
 *    fields.
 */
export interface CameraBufferData {
  // ───── Renderer-facing output ─────
  pos: [number, number, number];
  yaw: number;   // radians, around +Y, 0 = looking down -Z
  pitch: number; // radians, around camera-local +X
  fov: number;   // degrees
  aspect: number;
  near: number;
  far: number;
  /**
   * Unit world-space look direction (pivot − pos, normalized). Written by
   * CameraOrbitSystem. Gameplay systems that need the camera's *actual*
   * forward direction in world space read this — using the world-Y yaw is
   * lossy on non-flat-Y gravity because R_Y(yaw)·(0,0,-1) discards the
   * camera's vertical component.
   */
  lookDir: [number, number, number];

  // ───── Pivot state ─────
  pivot: {
    position: [number, number, number];
    up: [number, number, number];   // unit; local gravity-up at pivot
    fwd: [number, number, number];  // unit; parallel-transported horizontal forward
  };

  // ───── Target spherical coords ─────
  target: {
    distance: number;
    yaw: number;
    pitch: number;
    roll: number;  // 0 in MVP; reserved for banking / Dutch angle
    fov: number;
  };

  // ───── Parameters ─────
  params: {
    pivotResponsiveness: number;    // 1/s; pivot chases character at this rate
    orbitResponsiveness: number;    // 1/s; pos/yaw/pitch chase target at this rate
    distance: number;               // default orbit radius
    pitchMin: number;               // radians; HARD floor above local horizon
    pitchSoftMin: number;           // radians; soft cushion begins here
    pitchCushionStiffness: number;  // 1/s²; restoring acceleration scale
    pitchMax: number;               // radians; max elevation (just below straight up)
    fovDefault: number;
  };
}

export const CAMERA_BUFFER_ID = "camera";

export function createCameraBuffer(): Buffer<CameraBufferData> {
  return createBuffer<CameraBufferData>({
    id: CAMERA_BUFFER_ID,
    description:
      "Source-of-truth camera state. Renderer-facing fields (pos/yaw/pitch/fov/aspect/near/far) are mirrored into THREE.PerspectiveCamera by RenderSystem. " +
      "Pivot (position/up/fwd) is the orbit centre, written by CameraPivotSystem from the character + local gravity. " +
      "Target spherical coords (distance/yaw/pitch/roll/fov) + params (responsiveness, pitch cushion, FOV default) drive CameraOrbitSystem's chase.",
    initial: {
      pos: [0, 8, 60],
      yaw: 0,
      pitch: 0,
      fov: 70,
      aspect: 1,
      near: 0.1,
      far: 800,
      lookDir: [0, 0, -1],
      pivot: {
        position: [0, 0, 0],
        up: [0, 1, 0],
        fwd: [0, 0, -1],
      },
      target: {
        // Default pitch and distance picked so that on flat gravity the
        // camera sits at the same offset the pre-refactor camera produced:
        // (0, 2.6, 6) relative to pivot — i.e. atan(2.6/6) above horizon
        // at horizontal distance 6m, total radius √(6² + 2.6²) ≈ 6.54.
        distance: Math.hypot(6, 2.6),
        yaw: 0,
        pitch: Math.atan2(2.6, 6),
        roll: 0,
        fov: 70,
      },
      params: {
        pivotResponsiveness: 12.0,
        orbitResponsiveness: 10.0,
        distance: Math.hypot(6, 2.6),
        pitchMin: 0.05,
        pitchSoftMin: 0.18,
        pitchCushionStiffness: 40.0,
        pitchMax: Math.PI / 2 - 0.05,
        fovDefault: 70,
      },
    },
  });
}
