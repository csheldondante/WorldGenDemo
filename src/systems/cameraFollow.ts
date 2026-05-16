import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../buffers/inputMap";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../buffers/volumeField";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { INPUT_MAPPER_SYSTEM_ID } from "./inputMapper";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";
import { pickGravity, sortVolumesByPriority } from "../lib/math/gravityVolume";

export const CAMERA_FOLLOW_SYSTEM_ID = "cameraFollowSystem";

const FOLLOW_DISTANCE = 6.5; // meters; constant orbit radius
const PITCH_LIMIT = Math.PI / 2 - 0.08; // clamp polar phi (~0.08 rad away from the up/down poles)

/**
 * Spherical-orbit third-person camera with parallel-transported forward.
 *
 *   up   — `-normalize(gravity)` at the player; fallback world +Y.
 *   fwd  — the camera's actual world-space forward, persisted across ticks. Each
 *          tick we re-project last frame's fwd onto the new up-tangent plane
 *          (parallel transport) so the camera frame stays continuous as up
 *          rotates around the player on curved gravity scenes. User look-delta
 *          rotates fwd around up (yaw axis); pitch tilts the camera above the
 *          horizon plane.
 *   pos  — player + (cos(pitch)·(-fwd) + sin(pitch)·up) · FOLLOW_DISTANCE.
 *
 * Eliminates the fixed-reference-axis flip that snapped the camera when up
 * crossed certain orientations (e.g., walking around the side of a horizontal
 * cylinder, where up rotates through world ±Z and the old code switched its
 * reference forward at the threshold).
 *
 * RenderSystem applies via `camera.up = up; camera.lookAt(target)`.
 */
export function createCameraFollowSystem(): SystemDescriptor {
  return {
    id: CAMERA_FOLLOW_SYSTEM_ID,
    description:
      "Spherical-orbit camera. Persists camera-forward across ticks and parallel-transports it as gravity-up rotates so the camera frame stays continuous on curved gravity scenes. Reads InputMap.lookDelta, TransformBuffer, VolumeFieldBuffer; writes CameraBuffer pos/target/up/fwd.",
    buffers: [
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      SURFACE_CONSTRAINT_SYSTEM_ID,
      INPUT_MAPPER_SYSTEM_ID,
      CHARACTER_INPUT_SYSTEM_ID,
      FORCE_FIELD_SYSTEM_ID,
    ],
    execute: ({ buffer }) => {
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const cam = buffer<CameraBufferData>(CAMERA_BUFFER_ID);
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const vf = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));

      // Pick the focus target. With no character, keep the buffer state untouched.
      const targetId = cc.byEntity.keys().next().value as number | undefined;
      if (targetId === undefined) {
        // Still accumulate look input so the camera "spins in place" doesn't reset on respawn.
        writeBuffer(cam, (c) => {
          c.yaw += im.lookDelta.yaw;
          c.pitch += im.lookDelta.pitch;
          if (c.pitch > PITCH_LIMIT) c.pitch = PITCH_LIMIT;
          if (c.pitch < -PITCH_LIMIT) c.pitch = -PITCH_LIMIT;
        });
        return;
      }
      const t = transforms.byEntity.get(targetId);
      if (!t) return;

      // Gravity at the player position → up. Fallback world +Y on zero gravity.
      const sortedVolumes = vf.volumes.length > 0 ? sortVolumesByPriority(vf.volumes) : vf.volumes;
      const g = pickGravity(sortedVolumes, vf.gravity, t.position);
      const gLen = Math.hypot(g[0], g[1], g[2]);
      let upX = 0, upY = 1, upZ = 0;
      if (gLen > 1e-6) {
        upX = -g[0] / gLen; upY = -g[1] / gLen; upZ = -g[2] / gLen;
      }

      const c = readBuffer(cam);
      // Parallel transport: project last tick's fwd onto the new up-tangent plane.
      // For small frame-to-frame changes in `up` this is the correct minimal-rotation
      // update; the camera frame "rolls" smoothly with up rather than snapping.
      let fwdX = c.fwd[0], fwdY = c.fwd[1], fwdZ = c.fwd[2];
      const fDotUp = fwdX * upX + fwdY * upY + fwdZ * upZ;
      fwdX -= fDotUp * upX;
      fwdY -= fDotUp * upY;
      fwdZ -= fDotUp * upZ;
      let fwdLen = Math.hypot(fwdX, fwdY, fwdZ);
      if (fwdLen < 1e-6) {
        // Persisted fwd was (nearly) parallel to new up — pick a fresh tangent
        // direction. Try world -Z; if that's also nearly parallel, world +X.
        const wzDot = -upZ;
        if (Math.abs(wzDot) < 0.95) {
          fwdX = -upX * wzDot;
          fwdY = -upY * wzDot;
          fwdZ = -1 - upZ * wzDot;
        } else {
          const wxDot = upX;
          fwdX = 1 - upX * wxDot;
          fwdY = -upY * wxDot;
          fwdZ = -upZ * wxDot;
        }
        fwdLen = Math.hypot(fwdX, fwdY, fwdZ) || 1;
      }
      fwdX /= fwdLen; fwdY /= fwdLen; fwdZ /= fwdLen;

      // Apply look-delta yaw as a rotation of fwd around up: fwd' = cos(δ)·fwd + sin(δ)·(up×fwd).
      const sideX = upY * fwdZ - upZ * fwdY;
      const sideY = upZ * fwdX - upX * fwdZ;
      const sideZ = upX * fwdY - upY * fwdX;
      const dy = im.lookDelta.yaw;
      const cdy = Math.cos(dy);
      const sdy = Math.sin(dy);
      const newFwdX = cdy * fwdX + sdy * sideX;
      const newFwdY = cdy * fwdY + sdy * sideY;
      const newFwdZ = cdy * fwdZ + sdy * sideZ;

      // Accumulate look-delta pitch and clamp.
      let pitch = c.pitch + im.lookDelta.pitch;
      if (pitch > PITCH_LIMIT) pitch = PITCH_LIMIT;
      if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;

      // Camera direction from player = cos(pitch)·(-fwd) + sin(pitch)·up. Constant radius.
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const dirX = -cp * newFwdX + sp * upX;
      const dirY = -cp * newFwdY + sp * upY;
      const dirZ = -cp * newFwdZ + sp * upZ;

      writeBuffer(cam, (next) => {
        next.yaw += dy; // back-compat: minimap still reads cam.yaw as accumulated azimuth
        next.pitch = pitch;
        next.pos = [
          t.position[0] + dirX * FOLLOW_DISTANCE,
          t.position[1] + dirY * FOLLOW_DISTANCE,
          t.position[2] + dirZ * FOLLOW_DISTANCE,
        ];
        next.target = [t.position[0], t.position[1], t.position[2]];
        next.up = [upX, upY, upZ];
        next.fwd = [newFwdX, newFwdY, newFwdZ];
      });
    },
  };
}
