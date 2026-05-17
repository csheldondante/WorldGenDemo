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
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import {
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../buffers/surfaceAttachment";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";

export const CHARACTER_ORIENTATION_SYSTEM_ID = "characterOrientationSystem";

/** Below this magnitude the per-tick look-delta is treated as "no input." */
const LOOK_INPUT_EPSILON = 1e-6;

/**
 * Body-yaw controller. Mirrors the linear-motion controller's phases:
 *
 *   target → desired yawVel (P-gain × offset, clamped to desiredTurnRate)
 *          → required accel ((desired − current) / dt)
 *          → effective accel (clamped to ±turnAccelMax)
 *          → integrate (yawVel += eff·dt; yaw = wrap(yaw + yawVel·dt))
 *
 * Target-latch rule (per the user 2026-05-11):
 *
 *   1. If moving forward-ish: `target = cam.yaw − atan2(moveX, moveY)` —
 *      the world-direction of movement. Body faces where it's going.
 *   2. Else if look input is active (mouse moving or stick deflected):
 *      `target = cam.yaw`. Lets the player look around while standing still
 *      and have the body follow.
 *   3. Else: target unchanged. Idle camera + idle player → body holds.
 *
 * Any nonzero move stick rotates the body to face the world-direction of
 * movement, including backward-toward-camera (pressing S while camera trails
 * behind → body pivots 180° to face the camera, runs toward it). Movement
 * trumps camera unconditionally.
 *
 * Strafing → body faces the strafe direction (camera ± 90°). Side-stepping
 * makes the gait observable from the side because the camera and body are
 * perpendicular during a strafe.
 *
 * Future per the user's earlier note: split this into hip yaw (tracks
 * movement direction) and torso yaw (tracks look direction). Currently
 * both ride `Transform.yaw`.
 */
export function createCharacterOrientationSystem(): SystemDescriptor {
  return {
    id: CHARACTER_ORIENTATION_SYSTEM_ID,
    description:
      "Second-order body yaw controller. Latches targetYaw to camera yaw only when look input is active (mouse delta or right stick); chases via desired-velocity + capped-acceleration phases. Writes Transform.yaw and CharacterController.{yawVel, targetYaw}.",
    buffers: [
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID],
    runsBefore: [FORCE_FIELD_SYSTEM_ID, CHARACTER_CONTROLLER_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const cam = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const sa = readBuffer(buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID));
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);

      const moveX = im.moveAxis.x;
      const moveY = im.moveAxis.y;
      const moveMagSq = moveX * moveX + moveY * moveY;
      const lookActive =
        Math.abs(im.lookDelta.yaw) > LOOK_INPUT_EPSILON ||
        Math.abs(im.lookDelta.pitch) > LOOK_INPUT_EPSILON;

      // Camera's world-space look direction. Using the full 3D direction
      // (not R_Y(cam.yaw)·(0,0,-1) which has y=0) is essential on non-flat-Y
      // gravity — on a surface where the normal isn't world-Y, the yaw-
      // reconstructed forward projected onto the tangent plane collapses
      // to a degenerate line (or zero). cam.lookDir keeps the camera's
      // vertical component, which on projection recovers the actual
      // screen-forward direction on the puck's surface.
      const camFwX = cam.lookDir[0];
      const camFwY = cam.lookDir[1];
      const camFwZ = cam.lookDir[2];

      writeBuffer(ccBuf, (cc) => {
        writeBuffer(tBuf, (transforms) => {
          for (const [id, ctrl] of cc.byEntity) {
            const profile = profiles.byId.get(ctrl.profileId);
            if (!profile) continue;
            const t = transforms.byEntity.get(id);
            if (!t) continue;

            // Surface normal at this entity's puck position. Falls back to
            // world +Y if airborne — on flat-Y gravity the projection below
            // is a no-op and the math reduces to the legacy `cam.yaw -
            // atan2(moveX, moveY)` form.
            const att = sa.byEntity.get(id);
            let Nx = 0, Ny = 1, Nz = 0;
            if (att && att.sample) {
              Nx = att.sample.normal[0];
              Ny = att.sample.normal[1];
              Nz = att.sample.normal[2];
            }

            // Project camera-forward onto the tangent plane perpendicular to N.
            // Same math as tangentInputMapper.ts:97-114 — keeps the body's
            // yaw frame consistent with where the controller is pushing the
            // puck, instead of using world-Y yaw on a sphere/cylinder where
            // it's meaningless.
            const FdotN = camFwX * Nx + camFwY * Ny + camFwZ * Nz;
            let FtX = camFwX - FdotN * Nx;
            let FtY = camFwY - FdotN * Ny;
            let FtZ = camFwZ - FdotN * Nz;
            const FtLen = Math.hypot(FtX, FtY, FtZ);
            if (FtLen < 1e-6) {
              // Camera looking straight along the surface normal — no
              // well-defined tangent forward. Hold previous targetYaw.
            } else {
              FtX /= FtLen; FtY /= FtLen; FtZ /= FtLen;
              // Right-tangent = Ft × N (right-handed; matches tangentInputMapper).
              // Only x and z components feed the world-Y Euler conversion below;
              // y is computed for completeness but discarded.
              const RtX = FtY * Nz - FtZ * Ny;
              const RtZ = FtX * Ny - FtY * Nx;

              // Desired tangent facing: rotate Ft toward Rt by the input angle.
              // atan2(moveX, moveY) = 0 for pure forward, π/2 for pure right.
              // If no move input but look is active, face Ft directly (α=0).
              let useTangent = false;
              let alpha = 0;
              if (moveMagSq > 0.01) {
                useTangent = true;
                alpha = Math.atan2(moveX, moveY);
              } else if (lookActive) {
                useTangent = true;
                alpha = 0;
              }
              if (useTangent) {
                const ca = Math.cos(alpha);
                const sina = Math.sin(alpha);
                const dFx = FtX * ca + RtX * sina;
                const dFz = FtZ * ca + RtZ * sina;
                const xzMag = Math.hypot(dFx, dFz);
                if (xzMag > 1e-6) {
                  // R_Y(yaw)·(0,0,-1) = (-sin(yaw), 0, -cos(yaw)). Match dFwd's
                  // XZ components: sin(yaw) = -dFx, cos(yaw) = -dFz.
                  ctrl.targetYaw = Math.atan2(-dFx, -dFz);
                }
                // else: desired facing is nearly parallel to world-Y (e.g.
                // facing straight up on a horizontal wall). Hold previous
                // targetYaw rather than emit noisy spin — analogous to the
                // camera's gimbal-lock guard.
              }
            }

            const offset = wrapPi(ctrl.targetYaw - t.yaw);
            const desiredVel = clamp(profile.turnPGain * offset, -profile.desiredTurnRate, profile.desiredTurnRate);
            const aReq = (desiredVel - ctrl.yawVel) / dt;
            const aEff = clamp(aReq, -profile.turnAccelMax, profile.turnAccelMax);
            ctrl.yawVel += aEff * dt;
            t.yaw = wrapPi(t.yaw + ctrl.yawVel * dt);
          }
        });
      });
    },
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

function wrapPi(x: number): number {
  const TAU = Math.PI * 2;
  let r = x % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}
