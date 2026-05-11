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
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";

export const CHARACTER_ORIENTATION_SYSTEM_ID = "characterOrientationSystem";

/**
 * Body-yaw controller. Mirrors the linear-motion phases on the character
 * controller: input → desired velocity → required acceleration → capped
 * acceleration → integrate. The signal is angular instead of linear:
 *
 *   1. Compute targetYaw from camera + movement input (with walk-backward
 *      threshold: large backward stick → don't spin, keep facing camera).
 *   2. desiredYawVel = clamp(turnPGain * (target - current), ±desiredTurnRate).
 *      Proportional zone eases small-angle settle; large offsets saturate.
 *   3. requiredYawAccel = (desiredYawVel - currentYawVel) / dt.
 *   4. Clamp to ±turnAccelMax; integrate yawVel; integrate yaw; wrap to [-π, π].
 *
 * Why a separate system instead of folding it into the linear controller:
 * orientation is a generic concern (AI, vehicles, mounts will all need it),
 * and the read/write footprint is tight (camera, input, transform, controller
 * state — no surface, no velocity buffer). Keeping it standalone means the
 * existing linear physics doesn't grow another responsibility.
 *
 * Future (per user 2026-05-11):
 *   - Hip yaw vs torso yaw split: hips track movement direction, torso tracks
 *     camera/look direction. Currently we conflate them on transform.yaw.
 *   - Smoothed walk-backward blend instead of the discrete threshold below.
 *   - AI input source: drop in a "desired movement vector" from a planner;
 *     same code path computes targetYaw and turns at the profile's rate.
 */
export function createCharacterOrientationSystem(): SystemDescriptor {
  return {
    id: CHARACTER_ORIENTATION_SYSTEM_ID,
    description:
      "Second-order body yaw controller. Computes targetYaw from camera + movement (with walk-backward threshold), chases via desired-velocity + capped-acceleration phases mirroring the linear motion controller. Writes Transform.yaw and CharacterController.yawVel.",
    buffers: [
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID],
    // We write characterController (yawVel) and transform (yaw). ForceField
    // reads characterController, and CharacterControllerSystem writes it —
    // both need to see a stable orientation, so we precede them.
    runsBefore: [FORCE_FIELD_SYSTEM_ID, CHARACTER_CONTROLLER_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const cam = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);

      const moveX = im.moveAxis.x;
      const moveY = im.moveAxis.y;
      const moveMagSq = moveX * moveX + moveY * moveY;

      writeBuffer(ccBuf, (cc) => {
        writeBuffer(tBuf, (transforms) => {
          for (const [id, ctrl] of cc.byEntity) {
            const profile = profiles.byId.get(ctrl.profileId);
            if (!profile) continue;
            const t = transforms.byEntity.get(id);
            if (!t) continue;

            // ----- target yaw from camera + movement direction -----------
            // No movement input → face camera.
            // Backward input past the threshold → face camera (walk backward).
            // Otherwise → face the world-direction of movement.
            let targetYaw = cam.yaw;
            if (moveMagSq > 0.01 && moveY > profile.walkBackwardYThreshold) {
              // Movement direction in world. Derivation: world velocity =
              // moveX*camRight + moveY*camForward; with three.js convention
              // (yaw rotates +Y CCW, camForward = (-sin yaw, 0, -cos yaw)),
              // the yaw whose forward equals that velocity is
              //   cam.yaw - atan2(moveX, moveY).
              targetYaw = cam.yaw - Math.atan2(moveX, moveY);
            }

            // ----- phase 1: desired turn rate -----------------------------
            const offset = wrapPi(targetYaw - t.yaw);
            const desiredVel = clamp(profile.turnPGain * offset, -profile.desiredTurnRate, profile.desiredTurnRate);

            // ----- phase 2: required angular acceleration -----------------
            const aReq = (desiredVel - ctrl.yawVel) / dt;

            // ----- phase 3: cap by profile --------------------------------
            const aEff = clamp(aReq, -profile.turnAccelMax, profile.turnAccelMax);

            // ----- phase 4: integrate ------------------------------------
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

/** Wrap an angle to the (-π, π] range. */
function wrapPi(x: number): number {
  const TAU = Math.PI * 2;
  let r = x % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}
