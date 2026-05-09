import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import {
  CHARACTER_INPUT_BUFFER_ID,
  type CharacterInputBufferData,
} from "../buffers/characterInput";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
  type ControllerState,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../buffers/surfaceAttachment";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../buffers/surfaceProvider";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";

export const CHARACTER_CONTROLLER_SYSTEM_ID = "characterControllerSystem";

/**
 * The FSM heart. Reads input + current state, applies acceleration profile to
 * velocity, evaluates threshold transitions.
 *
 * V1 Phase 2A states implemented: surfaceRun, surfaceSlide, airborne, jump (impulse).
 * Phase 2B will fill in wingLaunch, flap, glide.
 */
export function createCharacterControllerSystem(): SystemDescriptor {
  return {
    id: CHARACTER_CONTROLLER_SYSTEM_ID,
    description:
      "Per-character FSM. Applies desired velocity via acceleration profile; emits jump impulses; evaluates slope/landing threshold transitions.",
    buffers: [
      { id: CHARACTER_INPUT_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID, FORCE_FIELD_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const ci = readBuffer(buffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const sa = readBuffer(buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID));
      const sp = readBuffer(buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID));
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);

      writeBuffer(ccBuf, (cc) => {
        writeBuffer(vBuf, (vel) => {
          for (const [id, ctrl] of cc.byEntity) {
            const profile = profiles.byId.get(ctrl.profileId);
            if (!profile) continue;
            const input = ci.byEntity.get(id);
            if (!input) continue;
            const v = vel.byEntity.get(id) ?? { linear: [0, 0, 0] as [number, number, number] };

            // Camera-frame movement projection
            const sy = Math.sin(input.cameraYaw), cy = Math.cos(input.cameraYaw);
            const fwdX = -sy, fwdZ = -cy;
            const rightX = cy, rightZ = -sy;
            let desiredX = input.moveX * rightX + input.moveY * fwdX;
            let desiredZ = input.moveX * rightZ + input.moveY * fwdZ;
            const moveLen = Math.hypot(desiredX, desiredZ);
            if (moveLen > 0) {
              desiredX /= moveLen;
              desiredZ /= moveLen;
            }

            ctrl.timeInState += dt;

            switch (ctrl.state) {
              case "surfaceRun":
              case "surfaceSlide": {
                const att = sa.byEntity.get(id);
                const slopeRad = att?.sample?.slopeRad ?? 0;

                // Slope check: enter slide / leave slide
                if (ctrl.state === "surfaceRun" && slopeRad > profile.slopeRunMaxRad) {
                  setState(ctrl, "surfaceSlide", `slope ${slopeRad.toFixed(2)}>${profile.slopeRunMaxRad.toFixed(2)}`);
                } else if (ctrl.state === "surfaceSlide" && slopeRad < profile.slopeStandMaxRad) {
                  setState(ctrl, "surfaceRun", `slope eased to ${slopeRad.toFixed(2)}`);
                }

                // Acceleration in horizontal velocity space
                const targetSpeed = ctrl.state === "surfaceRun" ? profile.runSpeed : profile.runSpeed * 1.2;
                const desiredVX = desiredX * targetSpeed;
                const desiredVZ = desiredZ * targetSpeed;
                const accelLimit = ctrl.state === "surfaceRun" ? profile.runAccel : profile.runAccel * 0.4;
                v.linear[0] = approach(v.linear[0], desiredVX, accelLimit, dt);
                v.linear[2] = approach(v.linear[2], desiredVZ, accelLimit, dt);
                // Brake when no input on the ground
                if (moveLen === 0 && ctrl.state === "surfaceRun") {
                  v.linear[0] = approach(v.linear[0], 0, profile.runBrake, dt);
                  v.linear[2] = approach(v.linear[2], 0, profile.runBrake, dt);
                }
                v.linear[1] = 0;

                // Jump: edge press → switch to airborne with vertical impulse
                if (input.jumpPressed) {
                  v.linear[1] = profile.jumpImpulse;
                  ctrl.locomotionMode = "volumeConstrained";
                  setState(ctrl, "airborne", "jump pressed");
                }
                break;
              }
              case "airborne":
              case "wingLaunch":
              case "flap":
              case "glide": {
                // Air control toward desired horizontal velocity
                const desiredVX = desiredX * profile.airSpeedCap;
                const desiredVZ = desiredZ * profile.airSpeedCap;
                v.linear[0] = approach(v.linear[0], desiredVX, profile.airAccel, dt);
                v.linear[2] = approach(v.linear[2], desiredVZ, profile.airAccel, dt);
                // Vertical comes from gravity (added by ForceFieldSystem) +
                // VelocityIntegrationSystem; we don't touch v.linear[1] here for V1
                // (Phase 2B will add flap/glide forward boost).

                // Landing: detect surface proximity (handled in SurfaceConstraintSystem
                // by re-attaching when y is close enough). The transition reason
                // surface→volume sets that up.
                break;
              }
            }

            cc.byEntity.set(id, ctrl);
            vel.byEntity.set(id, v);
            void sp; void tBuf; // referenced for future glide uses
          }
        });
      });
    },
  };
}

function setState(ctrl: { state: ControllerState; lastTransitionReason: string; timeInState: number }, next: ControllerState, reason: string): void {
  if (ctrl.state === next) return;
  ctrl.state = next;
  ctrl.lastTransitionReason = reason;
  ctrl.timeInState = 0;
}

function approach(current: number, target: number, accelLimit: number, dt: number): number {
  const delta = target - current;
  const maxStep = accelLimit * dt;
  if (delta > maxStep) return current + maxStep;
  if (delta < -maxStep) return current - maxStep;
  return target;
}
