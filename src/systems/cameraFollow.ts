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

const FOLLOW_DISTANCE = 6;   // meters behind the player along camera-forward (in the gravity-tangent plane)
const FOLLOW_HEIGHT = 2.6;   // meters along the gravity-up axis above the player
const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * Third-person follow camera. Builds its basis around `up = -normalize(gravity)`
 * at the player's position, so the view stays "feet down, head up" relative to
 * gravity. On flat ground that's world +Y (matches the old behavior); on a
 * horizontal-axis cylinder with radial gravity, up swings around the axis as
 * the player traverses; on a vertical-axis concave wall, up is horizontal (along
 * the radial-inward direction).
 *
 * Yaw rotates camera-forward around `up` (gravity-tangent plane). Pitch rotates
 * camera-forward around `right = fwd × up`. Camera position = player − fwd·FD
 * + up·FH, so the offset is consistently relative to the player's local frame.
 *
 * Falls back to world +Y when the entity is outside any gravity volume and the
 * universal gravity is also zero.
 */
export function createCameraFollowSystem(): SystemDescriptor {
  return {
    id: CAMERA_FOLLOW_SYSTEM_ID,
    description:
      "Third-person follow camera. Builds basis around gravity-up at the player's position so feet-down stays feet-down on curved gravity scenes (radial gravity volumes etc). Reads InputMapBuffer.lookDelta, TransformBuffer, VolumeFieldBuffer; writes CameraBuffer pos/yaw/pitch.",
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

      // Update yaw/pitch from semantic look-delta (already in radians/tick).
      writeBuffer(cam, (c) => {
        c.yaw += im.lookDelta.yaw;
        c.pitch += im.lookDelta.pitch;
        if (c.pitch > PITCH_LIMIT) c.pitch = PITCH_LIMIT;
        if (c.pitch < -PITCH_LIMIT) c.pitch = -PITCH_LIMIT;
      });

      // Pick the first character entity as the follow target.
      const targetId = cc.byEntity.keys().next().value as number | undefined;
      if (targetId === undefined) return;
      const t = transforms.byEntity.get(targetId);
      if (!t) return;

      const c = readBuffer(cam);
      const sortedVolumes = vf.volumes.length > 0 ? sortVolumesByPriority(vf.volumes) : vf.volumes;
      const g = pickGravity(sortedVolumes, vf.gravity, t.position);
      const gLen = Math.hypot(g[0], g[1], g[2]);
      // up = -normalize(g); fall back to world +Y when gravity is effectively zero.
      let upX = 0, upY = 1, upZ = 0;
      if (gLen > 1e-6) {
        upX = -g[0] / gLen;
        upY = -g[1] / gLen;
        upZ = -g[2] / gLen;
      }

      // Build a stable "reference forward" in the up-tangent plane. Start from world -Z
      // (the conventional "into-screen" direction at yaw=0); if that's nearly parallel to
      // up, swap to world +X. Then strip the up-component and normalize.
      let refX = 0, refY = 0, refZ = -1;
      if (Math.abs(refX * upX + refY * upY + refZ * upZ) > 0.95) {
        refX = 1; refY = 0; refZ = 0;
      }
      const refDotUp = refX * upX + refY * upY + refZ * upZ;
      let rx = refX - refDotUp * upX;
      let ry = refY - refDotUp * upY;
      let rz = refZ - refDotUp * upZ;
      let rLen = Math.hypot(rx, ry, rz);
      if (rLen < 1e-6) { rx = 1; ry = 0; rz = 0; rLen = 1; } // truly degenerate fallback
      rx /= rLen; ry /= rLen; rz /= rLen;
      // Right (perpendicular to ref-forward and up) = up × ref.
      // Combined with c.yaw, this rotates camera-forward around `up`:
      //   fwdYaw = cos(yaw)·ref + sin(yaw)·(up × ref)
      const sxX = upY * rz - upZ * ry;
      const sxY = upZ * rx - upX * rz;
      const sxZ = upX * ry - upY * rx;
      const cy = Math.cos(c.yaw);
      const sy = Math.sin(c.yaw);
      let fwdX = cy * rx + sy * sxX;
      let fwdY = cy * ry + sy * sxY;
      let fwdZ = cy * rz + sy * sxZ;
      // Apply pitch: rotate fwd around right = fwd × up. Algebraically equivalent to
      //   fwd' = cos(pitch)·fwd + sin(pitch)·up
      // when fwd ⊥ up. We use this compact form directly.
      const cp = Math.cos(c.pitch);
      const sp = Math.sin(c.pitch);
      fwdX = cp * fwdX + sp * upX;
      fwdY = cp * fwdY + sp * upY;
      fwdZ = cp * fwdZ + sp * upZ;
      // Right vector after pitch: right = fwd × up (still in tangent plane to up).
      const r2X = fwdY * upZ - fwdZ * upY;
      const r2Y = fwdZ * upX - fwdX * upZ;
      const r2Z = fwdX * upY - fwdY * upX;
      // Camera's true up (the "head" direction) lies in the (fwd, up)-plane after pitch:
      //   trueUp = up·cos(pitch) − fwd_before_pitch·sin(pitch) = up·cp − (cy·ref + sy·sxRef)·sp
      //   ≡ −fwd × right (always orthogonal to both).
      const tuX = r2Y * fwdZ - r2Z * fwdY;
      const tuY = r2Z * fwdX - r2X * fwdZ;
      const tuZ = r2X * fwdY - r2Y * fwdX;

      // Build the camera's orientation quaternion from the orthonormal basis
      // (right, trueUp, -fwd). THREE convention: camera looks down -Z, +Y up.
      // The rotation matrix columns are [right, trueUp, -fwd]; convert to quat.
      const m00 = r2X, m10 = r2Y, m20 = r2Z;
      const m01 = tuX, m11 = tuY, m21 = tuZ;
      const m02 = -fwdX, m12 = -fwdY, m22 = -fwdZ;
      const trace = m00 + m11 + m22;
      let qx: number, qy: number, qz: number, qw: number;
      if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        qw = 0.25 / s;
        qx = (m21 - m12) * s;
        qy = (m02 - m20) * s;
        qz = (m10 - m01) * s;
      } else if (m00 > m11 && m00 > m22) {
        const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
        qw = (m21 - m12) / s;
        qx = 0.25 * s;
        qy = (m01 + m10) / s;
        qz = (m02 + m20) / s;
      } else if (m11 > m22) {
        const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
        qw = (m02 - m20) / s;
        qx = (m01 + m10) / s;
        qy = 0.25 * s;
        qz = (m12 + m21) / s;
      } else {
        const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
        qw = (m10 - m01) / s;
        qx = (m02 + m20) / s;
        qy = (m12 + m21) / s;
        qz = 0.25 * s;
      }

      writeBuffer(cam, (next) => {
        next.pos = [
          t.position[0] - fwdX * FOLLOW_DISTANCE + upX * FOLLOW_HEIGHT,
          t.position[1] - fwdY * FOLLOW_DISTANCE + upY * FOLLOW_HEIGHT,
          t.position[2] - fwdZ * FOLLOW_DISTANCE + upZ * FOLLOW_HEIGHT,
        ];
        next.quaternion = [qx, qy, qz, qw];
      });
    },
  };
}
