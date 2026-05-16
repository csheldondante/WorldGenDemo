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
 * Spherical-orbit third-person camera. The camera lives on a sphere of constant
 * `FOLLOW_DISTANCE` around the player, with `up` axis = local gravity-up.
 *
 *   yaw   — azimuth around `up`. Rotates the camera around the player. Distance
 *           is invariant under yaw.
 *   pitch — elevation above the orbit horizon. 0 = level with the player, +π/2 =
 *           directly above. Clamped to (−π/2+ε, π/2−ε) so we never hit the
 *           poles where the yaw axis degenerates.
 *
 * `up` comes from `-normalize(gravity)` at the player's position (so the orbit
 * stays correctly oriented inside radial gravity volumes like the cylinder gym).
 * Falls back to world +Y when gravity is effectively zero.
 *
 * RenderSystem applies the result via `camera.up.set(up); camera.lookAt(target)`,
 * which is the canonical "billboard-up at this axis, look at this point" setup
 * and avoids the YXZ-Euler vs gravity-up mismatch that breaks the old camera.
 */
export function createCameraFollowSystem(): SystemDescriptor {
  return {
    id: CAMERA_FOLLOW_SYSTEM_ID,
    description:
      "Spherical-orbit third-person camera. Orbits the player at constant radius around an `up` axis equal to local gravity-up (or world +Y as fallback). Reads InputMap.lookDelta, TransformBuffer, VolumeFieldBuffer. Writes CameraBuffer pos/target/up; render system applies via lookAt.",
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

      // Accumulate look-delta into yaw/pitch; clamp pitch.
      writeBuffer(cam, (c) => {
        c.yaw += im.lookDelta.yaw;
        c.pitch += im.lookDelta.pitch;
        if (c.pitch > PITCH_LIMIT) c.pitch = PITCH_LIMIT;
        if (c.pitch < -PITCH_LIMIT) c.pitch = -PITCH_LIMIT;
      });

      // Pick the first character entity as the focus target.
      const targetId = cc.byEntity.keys().next().value as number | undefined;
      if (targetId === undefined) return;
      const t = transforms.byEntity.get(targetId);
      if (!t) return;

      const c = readBuffer(cam);
      // Gravity at the player position → gravity-up. Fallback world +Y on zero gravity.
      const sortedVolumes = vf.volumes.length > 0 ? sortVolumesByPriority(vf.volumes) : vf.volumes;
      const g = pickGravity(sortedVolumes, vf.gravity, t.position);
      const gLen = Math.hypot(g[0], g[1], g[2]);
      let upX = 0, upY = 1, upZ = 0;
      if (gLen > 1e-6) {
        upX = -g[0] / gLen; upY = -g[1] / gLen; upZ = -g[2] / gLen;
      }

      // Reference horizontal forward in the up-tangent plane. Start from world -Z;
      // if that's nearly parallel to up (camera looking along the gravity axis,
      // e.g. cylinder axis pointing into the screen), fall back to world +X.
      let refX = 0, refY = 0, refZ = -1;
      if (Math.abs(refX * upX + refY * upY + refZ * upZ) > 0.95) {
        refX = 1; refY = 0; refZ = 0;
      }
      // Project off up, normalize.
      let dotRefUp = refX * upX + refY * upY + refZ * upZ;
      let fwdX = refX - dotRefUp * upX;
      let fwdY = refY - dotRefUp * upY;
      let fwdZ = refZ - dotRefUp * upZ;
      let fwdLen = Math.hypot(fwdX, fwdY, fwdZ);
      if (fwdLen < 1e-6) {
        // Truly degenerate (shouldn't be reachable after the +X swap). Best effort.
        fwdX = 1; fwdY = 0; fwdZ = 0; fwdLen = 1;
      }
      fwdX /= fwdLen; fwdY /= fwdLen; fwdZ /= fwdLen;

      // "side" = up × fwd, completes the right-handed frame in the up-tangent plane.
      const sideX = upY * fwdZ - upZ * fwdY;
      const sideY = upZ * fwdX - upX * fwdZ;
      const sideZ = upX * fwdY - upY * fwdX;

      // Yawed forward in the horizon plane:
      //   yawedFwd(θ) = cos(θ)·fwd + sin(θ)·side
      const cy = Math.cos(c.yaw);
      const sy = Math.sin(c.yaw);
      const yawedX = cy * fwdX + sy * sideX;
      const yawedY = cy * fwdY + sy * sideY;
      const yawedZ = cy * fwdZ + sy * sideZ;

      // Camera position is "behind" the player along yawedFwd, then lifted by pitch
      // toward `up`. cosφ·(-yawedFwd) + sinφ·up, scaled by FOLLOW_DISTANCE.
      //   pitch =  0   → camera in the horizon plane behind the player.
      //   pitch = +π/2 → camera directly above the player (capped).
      //   pitch = -π/2 → camera directly below the player (capped).
      // Distance is constant: no shift with yaw.
      const cp = Math.cos(c.pitch);
      const sp = Math.sin(c.pitch);
      const camDirX = -cp * yawedX + sp * upX;
      const camDirY = -cp * yawedY + sp * upY;
      const camDirZ = -cp * yawedZ + sp * upZ;

      writeBuffer(cam, (next) => {
        next.pos = [
          t.position[0] + camDirX * FOLLOW_DISTANCE,
          t.position[1] + camDirY * FOLLOW_DISTANCE,
          t.position[2] + camDirZ * FOLLOW_DISTANCE,
        ];
        next.target = [t.position[0], t.position[1], t.position[2]];
        next.up = [upX, upY, upZ];
      });
    },
  };
}
