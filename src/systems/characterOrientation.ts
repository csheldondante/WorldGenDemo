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
 *   3. Else: target unchanged. Idle camera + idle player → body holds. Walk-
 *      backward (`moveY < walkBackwardYThreshold`) also falls here — keeps
 *      pressing S from 180°-spinning the body.
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
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID],
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
      const lookActive =
        Math.abs(im.lookDelta.yaw) > LOOK_INPUT_EPSILON ||
        Math.abs(im.lookDelta.pitch) > LOOK_INPUT_EPSILON;

      writeBuffer(ccBuf, (cc) => {
        writeBuffer(tBuf, (transforms) => {
          for (const [id, ctrl] of cc.byEntity) {
            const profile = profiles.byId.get(ctrl.profileId);
            if (!profile) continue;
            const t = transforms.byEntity.get(id);
            if (!t) continue;

            // Two-tier latch: movement aims body; look-input fills the
            // standing-still case so the player can turn to look at things
            // without walking. Idle player + idle camera → body holds.
            if (moveMagSq > 0.01 && moveY > profile.walkBackwardYThreshold) {
              ctrl.targetYaw = cam.yaw - Math.atan2(moveX, moveY);
            } else if (lookActive) {
              ctrl.targetYaw = cam.yaw;
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
