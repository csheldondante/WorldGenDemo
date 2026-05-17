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
    execute: ({ buffer, dt }) => {
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const camBuf = buffer<CameraBufferData>(CAMERA_BUFFER_ID);
      const c0 = readBuffer(camBuf);

      // Accumulate lookDelta into target yaw/pitch. Pitch sign is flipped
      // from inputMapper's convention so mouse-down lifts the camera.
      let targetYaw = c0.target.yaw + im.lookDelta.yaw;
      let targetPitch = c0.target.pitch - im.lookDelta.pitch;

      // Damped cushion: when target.pitch drops below pitchSoftMin, apply an
      // exponential restoring step pulling it back toward pitchSoftMin. The
      // farther below, the larger the per-frame correction — feels like
      // resistance ramping in as the user pushes harder. Then hard-clamp to
      // pitchMin so we never cross the floor.
      const softMin = c0.params.pitchSoftMin;
      const hardMin = c0.params.pitchMin;
      const hardMax = c0.params.pitchMax;
      if (targetPitch < softMin) {
        const cushionAlpha = 1 - Math.exp(-Math.max(0, dt) * c0.params.pitchCushionStiffness);
        targetPitch += (softMin - targetPitch) * cushionAlpha;
      }
      if (targetPitch < hardMin) targetPitch = hardMin;
      if (targetPitch > hardMax) targetPitch = hardMax;

      // Wrap yaw into [-π, π] so floats don't accumulate over hours of play.
      if (targetYaw > Math.PI) targetYaw -= 2 * Math.PI;
      else if (targetYaw < -Math.PI) targetYaw += 2 * Math.PI;

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
      const desiredPos: Vec3 = [
        pivot[0] + offset[0] * distance,
        pivot[1] + offset[1] * distance,
        pivot[2] + offset[2] * distance,
      ];

      // Exponential chase rendered pos toward desiredPos. The chase
      // smooths sudden yaw/pitch flicks, sudden pivot shifts (cylinders),
      // and the cushion-driven target.pitch correction so the camera
      // never snaps.
      //
      // First-tick / teleport guard: if rendered pos is more than 3·distance
      // from desired (initial spawn, mode switch, scene change), snap
      // instead of gliding in from the buffer default.
      const dx = desiredPos[0] - c0.pos[0];
      const dy = desiredPos[1] - c0.pos[1];
      const dz = desiredPos[2] - c0.pos[2];
      const distToDesired = Math.hypot(dx, dy, dz);
      const snapThreshold = distance * 3;
      const orbitAlpha = distToDesired > snapThreshold
        ? 1
        : 1 - Math.exp(-Math.max(0, dt) * c0.params.orbitResponsiveness);
      const pos: [number, number, number] = [
        c0.pos[0] + dx * orbitAlpha,
        c0.pos[1] + dy * orbitAlpha,
        c0.pos[2] + dz * orbitAlpha,
      ];

      // Smooth FOV toward target.fov (target.fov stays at fovDefault in MVP
      // — Phase 5 will drive transitions). target.fov defaults from
      // params.fovDefault so existing scenarios get the same FOV.
      const fov = c0.fov + (c0.target.fov - c0.fov) * orbitAlpha;

      // Derive world-frame YXZ Euler angles from the SMOOTHED look direction
      // (pivot − rendered pos, unit). render.ts consumes these as
      // setFromEuler(pitch, yaw, 0, "YXZ") applied to [0,0,-1]:
      //   look = R_Y(world_yaw) · R_X(world_pitch) · [0,0,-1]
      //        = [−cos(world_pitch)·sin(world_yaw), sin(world_pitch), −cos(world_pitch)·cos(world_yaw)]
      // so world_pitch = asin(look.y), world_yaw = atan2(−look.x, −look.z).
      // Using the smoothed pos keeps the camera always pointing at the pivot
      // through the chase glide, so there's no double-smoothing artifact.
      const vx = pivot[0] - pos[0];
      const vy = pivot[1] - pos[1];
      const vz = pivot[2] - pos[2];
      const vlen = Math.hypot(vx, vy, vz) || 1;
      const viewX = vx / vlen;
      const viewY = vy / vlen;
      const viewZ = vz / vlen;
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
        c.fov = fov;
      });
    },
  };
}
