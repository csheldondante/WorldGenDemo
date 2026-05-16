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

const FOLLOW_DISTANCE = 6.5; // orbit radius (renormalized each tick)
// Limit how close offset can come to being parallel to `up`. dot(offset_unit, up) is
// clamped to ±cos(polar_min) so the camera never reaches the pole where pitch rotation
// becomes ambiguous.
const POLE_DOT_LIMIT = Math.cos(0.08); // ≈ 0.997 — ~4.5° margin from pole

/**
 * Third-person orbit camera, offset-vector model. State is the camera-to-target
 * offset as a world-space vector; user input rotates the offset.
 *
 *   up    = -normalize(gravity at target); fallback world +Y on zero gravity.
 *   yaw   delta → rotate offset around `up`.
 *   pitch delta → rotate offset around `side = normalize(cross(up, offset))`.
 *   Pole clamp: |dot(offset_unit, up)| ≤ POLE_DOT_LIMIT.
 *   Renormalize: |offset| = FOLLOW_DISTANCE (constant orbit radius).
 *
 *   pos = target + offset.
 *   fwd = -normalize(offset projected onto up-perp plane).
 *
 * No accumulated yaw/pitch scalars with fixed reference axes; no parallel transport.
 * When the player walks around a curved gravity scene (e.g. horizontal-axis cylinder),
 * `up` rotates per tick but the offset stays world-fixed — the camera "rolls" via
 * `lookAt(target)` with the new up, but doesn't auto-orbit. User mouses to track.
 */
export function createCameraFollowSystem(): SystemDescriptor {
  return {
    id: CAMERA_FOLLOW_SYSTEM_ID,
    description:
      "Third-person orbit camera, offset-vector model. State: a persistent camera-to-target offset rotated by user look-delta around the gravity-up axis (yaw) and the side axis (pitch). Up is a per-tick lookup from VolumeFieldBuffer. No accumulated yaw/pitch scalars, no reference-axis singularity, no parallel transport.",
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

      const targetId = cc.byEntity.keys().next().value as number | undefined;
      if (targetId === undefined) return; // no character yet (Loading state) — leave camera alone
      const t = transforms.byEntity.get(targetId);
      if (!t) return;

      // up: point-wise gravity lookup at the player's position.
      const sortedVolumes = vf.volumes.length > 0 ? sortVolumesByPriority(vf.volumes) : vf.volumes;
      const g = pickGravity(sortedVolumes, vf.gravity, t.position);
      const gLen = Math.hypot(g[0], g[1], g[2]);
      let upX = 0, upY = 1, upZ = 0;
      if (gLen > 1e-6) {
        upX = -g[0] / gLen; upY = -g[1] / gLen; upZ = -g[2] / gLen;
      }

      // Rotate the persistent offset by user look-delta. yaw around up, pitch around side.
      const c = readBuffer(cam);
      let oX = c.offset[0], oY = c.offset[1], oZ = c.offset[2];

      // -- yaw: rotate offset around `up` by lookDelta.yaw (Rodrigues for axis-angle) --
      const dyaw = im.lookDelta.yaw;
      if (dyaw !== 0) {
        const cy = Math.cos(dyaw), sy = Math.sin(dyaw);
        // up × offset
        const kX = upY * oZ - upZ * oY;
        const kY = upZ * oX - upX * oZ;
        const kZ = upX * oY - upY * oX;
        const kDotO = upX * oX + upY * oY + upZ * oZ;
        // o' = o·cos + (k × o)·sin + k·(k·o)·(1-cos) — Rodrigues with k=up (unit)
        const newOX = oX * cy + kX * sy + upX * kDotO * (1 - cy);
        const newOY = oY * cy + kY * sy + upY * kDotO * (1 - cy);
        const newOZ = oZ * cy + kZ * sy + upZ * kDotO * (1 - cy);
        oX = newOX; oY = newOY; oZ = newOZ;
      }

      // -- pitch: rotate offset around `side = normalize(cross(offset, up))` by lookDelta.pitch --
      // Sign convention: positive lookDelta.pitch tilts offset toward `up` (camera rises).
      // (Mouse-down convention in InputMapperSystem produces NEGATIVE pitch delta → camera
      // descends, looking up from below the player. Flip in inputMapper if you want the
      // opposite UI feel.)
      const dpitch = im.lookDelta.pitch;
      if (dpitch !== 0) {
        let sX = oY * upZ - oZ * upY;
        let sY = oZ * upX - oX * upZ;
        let sZ = oX * upY - oY * upX;
        const sLen = Math.hypot(sX, sY, sZ);
        if (sLen > 1e-6) {
          sX /= sLen; sY /= sLen; sZ /= sLen;
          const cp = Math.cos(dpitch), sp = Math.sin(dpitch);
          // Rodrigues around `side` (unit). k·o term is 0 since side ⊥ offset by construction.
          const kCrossOX = sY * oZ - sZ * oY;
          const kCrossOY = sZ * oX - sX * oZ;
          const kCrossOZ = sX * oY - sY * oX;
          oX = oX * cp + kCrossOX * sp;
          oY = oY * cp + kCrossOY * sp;
          oZ = oZ * cp + kCrossOZ * sp;
        }
      }

      // Renormalize offset to FOLLOW_DISTANCE.
      let oLen = Math.hypot(oX, oY, oZ);
      if (oLen < 1e-6) { oX = 0; oY = 0; oZ = FOLLOW_DISTANCE; oLen = FOLLOW_DISTANCE; }
      const scale = FOLLOW_DISTANCE / oLen;
      oX *= scale; oY *= scale; oZ *= scale;

      // Pole clamp: keep offset away from being parallel to up. If dot(offset_unit, up)
      // exceeds the limit, rotate offset back along the (up, offset) plane by the
      // excess angle so it sits at exactly the limit.
      const dot = (oX * upX + oY * upY + oZ * upZ) / FOLLOW_DISTANCE;
      if (Math.abs(dot) > POLE_DOT_LIMIT) {
        // Decompose offset into up-aligned and up-perp components, then re-balance so
        // dot equals ±POLE_DOT_LIMIT (sign preserved from original dot).
        const perpX = oX - dot * FOLLOW_DISTANCE * upX;
        const perpY = oY - dot * FOLLOW_DISTANCE * upY;
        const perpZ = oZ - dot * FOLLOW_DISTANCE * upZ;
        const perpLen = Math.hypot(perpX, perpY, perpZ);
        const clampedDot = dot > 0 ? POLE_DOT_LIMIT : -POLE_DOT_LIMIT;
        const targetPerpLen = FOLLOW_DISTANCE * Math.sqrt(1 - clampedDot * clampedDot);
        if (perpLen > 1e-6) {
          const k = targetPerpLen / perpLen;
          oX = perpX * k + clampedDot * FOLLOW_DISTANCE * upX;
          oY = perpY * k + clampedDot * FOLLOW_DISTANCE * upY;
          oZ = perpZ * k + clampedDot * FOLLOW_DISTANCE * upZ;
        }
      }

      // Derive published outputs.
      // fwd = -normalize(offset projected onto up-perp plane) — what the camera looks along
      // in the horizon plane. tangentInputMapperSystem projects this onto the surface
      // tangent plane to drive surface-frame input.
      const offDotUp = oX * upX + oY * upY + oZ * upZ;
      let fwdX = -(oX - offDotUp * upX);
      let fwdY = -(oY - offDotUp * upY);
      let fwdZ = -(oZ - offDotUp * upZ);
      const fwdLen = Math.hypot(fwdX, fwdY, fwdZ);
      if (fwdLen > 1e-6) { fwdX /= fwdLen; fwdY /= fwdLen; fwdZ /= fwdLen; }
      else { fwdX = 0; fwdY = 0; fwdZ = -1; }

      // Derived scalars for back-compat readers (minimap player arrow uses cam.yaw).
      const derivedYaw = Math.atan2(-fwdX, -fwdZ); // world XZ angle of camera fwd; matches old YXZ convention
      const derivedPitch = Math.asin(Math.max(-1, Math.min(1, -offDotUp / FOLLOW_DISTANCE)));

      writeBuffer(cam, (next) => {
        next.offset = [oX, oY, oZ];
        next.pos = [t.position[0] + oX, t.position[1] + oY, t.position[2] + oZ];
        next.target = [t.position[0], t.position[1], t.position[2]];
        next.up = [upX, upY, upZ];
        next.fwd = [fwdX, fwdY, fwdZ];
        next.yaw = derivedYaw;
        next.pitch = derivedPitch;
      });
    },
  };
}
