import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../buffers/inputMap";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { cross } from "../lib/math/vec3";
import type { Vec3 } from "../lib/math/quat";
import { INPUT_MAPPER_SYSTEM_ID } from "./inputMapper";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { CAMERA_PIVOT_SYSTEM_ID } from "./cameraPivot";

export const CAMERA_ORBIT_SYSTEM_ID = "cameraOrbitSystem";

/**
 * Third-person orbit camera. Reads InputMapBuffer.lookDelta + the
 * pivot frame written by CameraPivotSystem, writes the renderer-facing
 * pos/yaw/pitch.
 *
 * Math: orbit position is a spherical coordinate around `pivot.up`:
 *
 *     right    = cross(up, fwd)                  // lateral in pivot frame
 *     yawedFwd = fwd·cos(yaw) + right·sin(yaw)   // horizontal forward at this yaw
 *     pos      = pivot + (−yawedFwd·cos(pitch) + up·sin(pitch)) · distance
 *
 * `local yaw` rotates the camera around `pivot.up` (so the camera circles
 * the player matching how the world rotates around the gravity axis), and
 * `local pitch` lifts the camera above the local horizon (positive pitch =
 * camera elevates over the player). At zero pitch the camera sits at
 * pivot − yawedFwd · distance — the same direction the old "back-offset"
 * formula picked, but in a frame that follows the local gravity-up.
 *
 * Sign convention for mouse pitch (changed in Phase 2): pulling the mouse
 * DOWN should LIFT the camera. `lookDelta.pitch` is negative when the mouse
 * moves down (from the inputMapper convention), so target.pitch is updated
 * as `target.pitch − lookDelta.pitch` — mouse-down → pitch increases →
 * camera elevates over the pivot. This is the third-person convention used
 * by most games and is the only sign that's compatible with the Phase 3
 * "constrain camera above local horizon" cushion.
 *
 * Renderer interface: render.ts consumes `yaw`/`pitch` as world-frame
 * YXZ Euler angles. We derive them from the world-space view direction
 * `view = normalize(pivot − pos)` so the renderer doesn't need to know
 * about pivot frames. Gimbal lock near view‖±Y is handled by keeping the
 * previous yaw when |view.y| > 0.9995.
 */
export function createCameraOrbitSystem(): SystemDescriptor {
  return {
    id: CAMERA_ORBIT_SYSTEM_ID,
    description:
      "Third-person spherical orbit camera around CameraBuffer.pivot. Reads InputMapBuffer.lookDelta + pivot frame, writes pos/yaw/pitch/target. Uses local-pitch as elevation above pivot.up (sign-flipped mouse-pitch: mouse-down lifts camera).",
    buffers: [
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, INPUT_MAPPER_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID, CAMERA_PIVOT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const camBuf = buffer<CameraBufferData>(CAMERA_BUFFER_ID);
      const c0 = readBuffer(camBuf);

      // Accumulate lookDelta into target yaw/pitch. Pitch sign is flipped
      // from inputMapper's convention so mouse-down lifts the camera.
      let targetYaw = c0.target.yaw + im.lookDelta.yaw;
      let targetPitch = c0.target.pitch - im.lookDelta.pitch;

      // Hard clamp to params.pitchMax / pitchMin. Phase 3 introduces a
      // damped cushion at params.pitchSoftMin before the hard floor.
      if (targetPitch > c0.params.pitchMax) targetPitch = c0.params.pitchMax;
      if (targetPitch < c0.params.pitchMin) targetPitch = c0.params.pitchMin;

      // Wrap yaw into [-π, π] so floats don't accumulate over hours of play.
      if (targetYaw > Math.PI) targetYaw -= 2 * Math.PI;
      else if (targetYaw < -Math.PI) targetYaw += 2 * Math.PI;

      // Phase 2: instant chase — rendered = target. Phase 3 adds
      // exponential smoothing here.
      const yaw = targetYaw;
      const pitch = targetPitch;
      const distance = c0.params.distance;

      // Build the orbit position in the pivot frame.
      const up: Vec3 = c0.pivot.up;
      const fwd: Vec3 = c0.pivot.fwd;
      const right = cross(up, fwd);
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const yawedFwd: Vec3 = [
        fwd[0] * cy + right[0] * sy,
        fwd[1] * cy + right[1] * sy,
        fwd[2] * cy + right[2] * sy,
      ];
      const offset: Vec3 = [
        -yawedFwd[0] * cp + up[0] * sp,
        -yawedFwd[1] * cp + up[1] * sp,
        -yawedFwd[2] * cp + up[2] * sp,
      ];
      const pivot = c0.pivot.position;
      const pos: [number, number, number] = [
        pivot[0] + offset[0] * distance,
        pivot[1] + offset[1] * distance,
        pivot[2] + offset[2] * distance,
      ];

      // Derive world-frame YXZ Euler angles from the camera's look direction
      // (pivot − pos, unit). render.ts consumes these as
      // setFromEuler(pitch, yaw, 0, "YXZ") applied to [0,0,-1]:
      //   look = R_Y(world_yaw) · R_X(world_pitch) · [0,0,-1]
      //        = [−cos(world_pitch)·sin(world_yaw), sin(world_pitch), −cos(world_pitch)·cos(world_yaw)]
      // so world_pitch = asin(look.y), world_yaw = atan2(−look.x, −look.z).
      // The view direction here is (yawedFwd·cos(pitch) − up·sin(pitch)) — a unit vector by construction.
      const viewX = yawedFwd[0] * cp - up[0] * sp;
      const viewY = yawedFwd[1] * cp - up[1] * sp;
      const viewZ = yawedFwd[2] * cp - up[2] * sp;
      // Gimbal lock guard: when looking almost straight along ±world-Y, yaw
      // is undefined; keep the previous render yaw to avoid spin.
      let worldYaw: number;
      let worldPitch: number;
      if (viewY > 1) {
        worldPitch = Math.PI / 2;
        worldYaw = c0.yaw;
      } else if (viewY < -1) {
        worldPitch = -Math.PI / 2;
        worldYaw = c0.yaw;
      } else {
        worldPitch = Math.asin(viewY);
        if (Math.abs(viewY) > 0.9995) {
          worldYaw = c0.yaw;
        } else {
          worldYaw = Math.atan2(-viewX, -viewZ);
        }
      }

      writeBuffer(camBuf, (c) => {
        c.target.yaw = targetYaw;
        c.target.pitch = targetPitch;
        c.yaw = worldYaw;
        c.pitch = worldPitch;
        c.pos = pos;
      });
    },
  };
}
