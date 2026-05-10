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
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../buffers/forceAccumulator";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";

export const CHARACTER_CONTROLLER_SYSTEM_ID = "characterControllerSystem";

/**
 * Per-character FSM. In surface mode, runs the surface-frame solver: project
 * the existing accumulator (gravity + any other field forces) and the current
 * velocity into a tangent/normal basis aligned to the surface and the
 * character's facing; cap tangent control by min(directional profile cap,
 * grip budget); add a normal-direction surface reaction to keep v_N pinned.
 * Accelerations are accumulated additively; VelocityIntegration applies them.
 * Jumps are direct velocity impulses outside the loop.
 */
export function createCharacterControllerSystem(): SystemDescriptor {
  return {
    id: CHARACTER_CONTROLLER_SYSTEM_ID,
    description:
      "Per-character FSM. In surface mode, runs the surface-frame solver (project to tangent/normal basis, cap tangent control by min(profile, grip), add surface-reaction normal to absorb gravity-into-surface). Accumulates accelerations; jump impulses still write velocity directly.",
    buffers: [
      { id: CHARACTER_INPUT_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
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
      const faBuf = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);

      writeBuffer(ccBuf, (cc) => {
        writeBuffer(vBuf, (vel) => {
          writeBuffer(faBuf, (fa) => {
            for (const [id, ctrl] of cc.byEntity) {
              const profile = profiles.byId.get(ctrl.profileId);
              if (!profile) continue;
              const input = ci.byEntity.get(id);
              if (!input) continue;
              const v = vel.byEntity.get(id) ?? { linear: [0, 0, 0] as [number, number, number] };
              const accelEntry = fa.byEntity.get(id) ?? { accel: [0, 0, 0] as [number, number, number] };

              ctrl.timeInState += dt;

              if (ctrl.state === "surfaceRun" || ctrl.state === "surfaceSlide") {
                const att = sa.byEntity.get(id);
                const sample = att?.sample ?? null;
                const surface = sp.heightmap;
                if (sample) {
                  // ----- Build surface-aligned, character-aligned basis -----
                  const Nx = sample.normal[0], Ny = sample.normal[1], Nz = sample.normal[2];
                  const sy = Math.sin(input.cameraYaw), cy = Math.cos(input.cameraYaw);
                  // Camera/character forward (XZ only)
                  const FwX = -sy, FwY = 0, FwZ = -cy;
                  // Project Fw onto tangent plane: Ft = Fw − (Fw·N) N
                  const FdotN = FwX * Nx + FwY * Ny + FwZ * Nz;
                  let FtX = FwX - FdotN * Nx;
                  let FtY = FwY - FdotN * Ny;
                  let FtZ = FwZ - FdotN * Nz;
                  const FtLen = Math.hypot(FtX, FtY, FtZ) || 1;
                  FtX /= FtLen; FtY /= FtLen; FtZ /= FtLen;
                  // Rt = Ft × N (right in tangent plane; right-handed: forward × up = right).
                  // Already unit because both inputs are unit and orthogonal.
                  const RtX = FtY * Nz - FtZ * Ny;
                  const RtY = FtZ * Nx - FtX * Nz;
                  const RtZ = FtX * Ny - FtY * Nx;

                  // ----- Subtract surface anchor velocity (zero for static surfaces) -----
                  const uv = att!.uv;
                  const vSurf = surface ? surface.sampleVelocityAt(uv[0], uv[1]) : [0, 0, 0] as const;
                  const vRelX = v.linear[0] - vSurf[0];
                  const vRelY = v.linear[1] - vSurf[1];
                  const vRelZ = v.linear[2] - vSurf[2];

                  // ----- Project relative velocity into surface frame -----
                  const vF = vRelX * FtX + vRelY * FtY + vRelZ * FtZ;
                  const vR = vRelX * RtX + vRelY * RtY + vRelZ * RtZ;
                  const vN = vRelX * Nx + vRelY * Ny + vRelZ * Nz;

                  // ----- Desired velocity in tangent plane -----
                  const vDesF = input.moveY * profile.desiredRunSpeed;
                  const vDesR = input.moveX * profile.desiredRunSpeed;

                  // ----- Required acceleration to reach desired (this tick) -----
                  const aReqF = (vDesF - vF) / dt;
                  const aReqR = (vDesR - vR) / dt;

                  // ----- Existing accumulator: only the normal component is needed here.
                  // Tangent components (gravity-along-slope, etc.) stay in the accumulator
                  // and integrate naturally; we add control on top.
                  const aExN = accelEntry.accel[0] * Nx + accelEntry.accel[1] * Ny + accelEntry.accel[2] * Nz;

                  // ----- Friction grip = μ × |normal force from existing forces| -----
                  // |aExN| stands in for normal-force-per-unit-mass; on static surfaces under
                  // gravity, |aExN| = |g| × cos(slope).
                  const gripBudget = sample.friction * Math.abs(aExN);

                  // ----- Sign-aware character cap, then min with grip -----
                  const charCapF = aReqF >= 0 ? profile.forwardAccelMax : profile.backwardAccelMax;
                  const charCapR = profile.lateralAccelMax;
                  const capF = Math.min(charCapF, gripBudget);
                  const capR = Math.min(charCapR, gripBudget);
                  const aFEff = clampMag(aReqF, capF);
                  const aREff = clampMag(aReqR, capR);

                  // ----- Required surface-normal accel to pin v_N to 0 -----
                  // Net normal accel needed (in surface frame): -vN/dt
                  // Already in accumulator: aExN. Surface contributes the difference.
                  const aSurfaceNRequired = -vN / dt - aExN;
                  const aSurfaceN = Math.max(
                    -sample.normalOutMax,
                    Math.min(sample.normalInMax, aSurfaceNRequired),
                  );

                  // ----- State transitions (use REQUIRED, not capped, magnitudes) -----
                  const slipMag = Math.max(Math.abs(aReqF), Math.abs(aReqR));
                  let stateChanged = false;
                  if (aSurfaceNRequired > sample.normalInMax * profile.ragdollNormalInScale) {
                    // Surface stiffness exceeded — V1 has no ragdoll behavior yet, so detach to airborne.
                    setState(ctrl, "airborne", `smack: required normal-in ${aSurfaceNRequired.toFixed(0)} > ${(sample.normalInMax * profile.ragdollNormalInScale).toFixed(0)}`);
                    ctrl.locomotionMode = "volumeConstrained";
                    stateChanged = true;
                  } else if (aSurfaceNRequired < -sample.normalOutMax * profile.detachNormalOutScale) {
                    setState(ctrl, "airborne", `detach: required normal-out ${(-aSurfaceNRequired).toFixed(0)} > ${(sample.normalOutMax * profile.detachNormalOutScale).toFixed(0)}`);
                    ctrl.locomotionMode = "volumeConstrained";
                    stateChanged = true;
                  } else if (slipMag > gripBudget * profile.slideGripScale && ctrl.state === "surfaceRun") {
                    setState(ctrl, "surfaceSlide", "grip exceeded");
                  } else if (sample.slopeRad > profile.slopeRunMaxRad && ctrl.state === "surfaceRun") {
                    setState(ctrl, "surfaceSlide", `slope ${sample.slopeRad.toFixed(2)}>${profile.slopeRunMaxRad.toFixed(2)}`);
                  } else if (
                    ctrl.state === "surfaceSlide" &&
                    sample.slopeRad < profile.slopeStandMaxRad &&
                    Math.abs(vF) + Math.abs(vR) < 0.5
                  ) {
                    setState(ctrl, "surfaceRun", `slope eased to ${sample.slopeRad.toFixed(2)}`);
                  }

                  // ----- Add tangent control + surface reaction to the accumulator -----
                  // (Skip if we just detached — let airborne path run next tick.)
                  if (!stateChanged) {
                    accelEntry.accel[0] += aFEff * FtX + aREff * RtX + aSurfaceN * Nx;
                    accelEntry.accel[1] += aFEff * FtY + aREff * RtY + aSurfaceN * Ny;
                    accelEntry.accel[2] += aFEff * FtZ + aREff * RtZ + aSurfaceN * Nz;
                  }
                }

                // Jump: edge press → switch to airborne with vertical impulse.
                // (Direct velocity write — impulses are a separate channel from the
                // desired-velocity loop.)
                if (input.jumpPressed && ctrl.locomotionMode === "surfaceConstrained") {
                  v.linear[1] = profile.jumpImpulse;
                  ctrl.locomotionMode = "volumeConstrained";
                  setState(ctrl, "airborne", "jump pressed");
                }
              } else {
                // Air states: simple horizontal-XZ velocity targeting.
                // Vertical comes from gravity (in the accumulator) + VelocityIntegration.
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
                const desiredVX = desiredX * profile.airSpeedCap;
                const desiredVZ = desiredZ * profile.airSpeedCap;
                v.linear[0] = approach(v.linear[0], desiredVX, profile.airAccel, dt);
                v.linear[2] = approach(v.linear[2], desiredVZ, profile.airAccel, dt);
              }

              cc.byEntity.set(id, ctrl);
              vel.byEntity.set(id, v);
              fa.byEntity.set(id, accelEntry);
              void tBuf;
            }
          });
        });
      });
    },
  };
}

function setState(
  ctrl: { state: ControllerState; lastTransitionReason: string; timeInState: number },
  next: ControllerState,
  reason: string,
): void {
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

function clampMag(value: number, magnitude: number): number {
  if (value > magnitude) return magnitude;
  if (value < -magnitude) return -magnitude;
  return value;
}
