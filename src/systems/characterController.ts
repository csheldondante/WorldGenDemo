import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import {
  CHARACTER_INPUT_BUFFER_ID,
  type CharacterInputBufferData,
} from "../buffers/characterInput";
import {
  CHARACTER_TANGENT_INPUT_BUFFER_ID,
  type CharacterTangentInputBufferData,
} from "../buffers/characterTangentInput";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
  type CharacterControllerComponent,
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
import { TANGENT_INPUT_MAPPER_SYSTEM_ID } from "./tangentInputMapper";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";
import { evaluateLinearAccel } from "../lib/math/accelCurve";
import { IS_DEV } from "../runtime/dev";

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
      { id: CHARACTER_TANGENT_INPUT_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID, TANGENT_INPUT_MAPPER_SYSTEM_ID, FORCE_FIELD_SYSTEM_ID],
    execute: ({ buffer, dt, now }) => {
      const ci = readBuffer(buffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID));
      const ti = readBuffer(buffer<CharacterTangentInputBufferData>(CHARACTER_TANGENT_INPUT_BUFFER_ID));
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
              const v = vel.byEntity.get(id) ?? {
                linear: [0, 0, 0] as [number, number, number],
                prevLinear: [0, 0, 0] as [number, number, number],
              };
              const accelEntry = fa.byEntity.get(id) ?? { accel: [0, 0, 0] as [number, number, number] };

              ctrl.timeInState += dt;

              if (ctrl.state === "surfaceRun" || ctrl.state === "surfaceSlide") {
                const att = sa.byEntity.get(id);
                const sample = att?.sample ?? null;
                const surface = sp.heightmap;
                const tangent = ti.byEntity.get(id);
                if (sample && tangent) {
                  // ----- Tangent frame + desired velocity from TangentInputMapperSystem -----
                  // We read the basis it computed (Ft, Rt) instead of recomputing here; same
                  // math, separated for clarity and to let non-camera input sources (AI,
                  // replay) write straight into the tangent buffer.
                  const Nx = sample.normal[0], Ny = sample.normal[1], Nz = sample.normal[2];
                  const FtX = tangent.forwardTangent[0], FtY = tangent.forwardTangent[1], FtZ = tangent.forwardTangent[2];
                  const RtX = tangent.rightTangent[0], RtY = tangent.rightTangent[1], RtZ = tangent.rightTangent[2];

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

                  // ----- Desired velocity in tangent plane (mapper handed us scalars) -----
                  // vDes already accounts for external accel — it's the x-intercept of the
                  // shifted biomechanical curve, scaled by input. See
                  // `wiki/worldgen-demo-accel-curve-and-desired-velocity.md`.
                  const vDesF = tangent.vDesF;
                  const vDesR = tangent.vDesR;

                  // ----- External accel projected onto the tangent frame -----
                  // Already in accumulator (from ForceField + radial-gravity volumes etc.).
                  // We need it on all three axes: aExN absorbs into the surface reaction (below);
                  // aExF / aExR are subtracted from the request so the controller's VOLUNTARY
                  // thrust is what's left after external. At steady state (v=vDes), aReqNet=0
                  // and the character produces voluntary = −aEx to coast — naturally tracks
                  // downhill speedup / headwind slowdown without special cases.
                  const aExN = accelEntry.accel[0] * Nx + accelEntry.accel[1] * Ny + accelEntry.accel[2] * Nz;
                  const aExF = accelEntry.accel[0] * FtX + accelEntry.accel[1] * FtY + accelEntry.accel[2] * FtZ;
                  const aExR = accelEntry.accel[0] * RtX + accelEntry.accel[1] * RtY + accelEntry.accel[2] * RtZ;

                  // ----- Required VOLUNTARY accel to reach desired (this tick) -----
                  // aReqNet = (vDes − v)/dt; aReqVoluntary = aReqNet − aEx.
                  const aReqF = (vDesF - vF) / dt - aExF;
                  const aReqR = (vDesR - vR) / dt - aExR;

                  // ----- Friction grip = μ × |normal force from existing forces| -----
                  const gripBudget = sample.friction * Math.abs(aExN);

                  // ----- Per-direction biomechanical ceilings -----
                  // Each ceiling is the maximum voluntary thrust the character's limbs can
                  // produce IN THAT DIRECTION at the current per-direction speed projection.
                  // Past vMax in that direction, the curve goes negative — "limbs are too slow
                  // to push at this speed; they drag." Voluntary range = [−backCeil, +fwdCeil],
                  // intersected with friction grip on both sides.
                  const fwdCeil  = evaluateLinearAccel(profile.forwardAccel,  Math.max(0,  vF));
                  const backCeil = evaluateLinearAccel(profile.backwardAccel, Math.max(0, -vF));
                  const rightCeil = evaluateLinearAccel(profile.lateralAccel, Math.max(0,  vR));
                  const leftCeil  = evaluateLinearAccel(profile.lateralAccel, Math.max(0, -vR));
                  // Cap ceilings by grip (positive only). Negative ceilings stay negative —
                  // they represent forced deceleration that grip can't suppress.
                  const fwdMax   = Math.min(fwdCeil,   gripBudget);
                  const backMax  = Math.min(backCeil,  gripBudget);
                  const rightMax = Math.min(rightCeil, gripBudget);
                  const leftMax  = Math.min(leftCeil,  gripBudget);
                  // Voluntary range: [−backMax, +fwdMax]. If both bounds are negative the
                  // range collapses to "can only decelerate" — clampToRange picks the closer
                  // bound and the controller's voluntary equals that bound.
                  const aFEff = clampToRange(aReqF, -backMax, fwdMax);
                  const aREff = clampToRange(aReqR, -leftMax, rightMax);

                  // ----- Centripetal demand from surface curvature -----
                  // Project world tangent velocity onto the surface's UV axes, then divide by
                  // |∂P/∂u|, |∂P/∂v| to get UV-parameter velocity (1/s). Feeding that into
                  // getCurvature returns the centripetal acceleration along +N (m/s²).
                  //   Sign convention: aCentripetalN < 0 → surface curves into −N (convex
                  //   hilltop, centripetal toward the axis below the body); aCentripetalN > 0
                  //   → concave bowl (centripetal pulling the body into +N).
                  const vTanU = vRelX * sample.tangentU[0] + vRelY * sample.tangentU[1] + vRelZ * sample.tangentU[2];
                  const vTanV = vRelX * sample.tangentV[0] + vRelY * sample.tangentV[1] + vRelZ * sample.tangentV[2];
                  const dUdt = sample.tangentUNorm > 0 ? vTanU / sample.tangentUNorm : 0;
                  const dVdt = sample.tangentVNorm > 0 ? vTanV / sample.tangentVNorm : 0;
                  const aCentripetalN = surface ? surface.getCurvature(uv[0], uv[1], dUdt, dVdt) : 0;

                  // ----- Required surface-normal accel to keep the body on the curved surface -----
                  // Net normal accel needed = aCentripetalN (so the body's trajectory matches the
                  // surface's curvature). Drive vN→0 as a stabilization term. External (gravity)
                  // contributes aExN; the surface must provide the remainder along +N.
                  const aSurfaceNRequired = aCentripetalN - vN / dt - aExN;
                  const aSurfaceN = Math.max(
                    -sample.normalOutMax,
                    Math.min(sample.normalInMax, aSurfaceNRequired),
                  );

                  // ----- Grip-based leave rule -----
                  // The surface must provide aSurfaceNRequired along +N to keep the body
                  // attached and following the surface's curvature. Negative aSurfaceNRequired
                  // means the surface needs to PULL the body in (the character's grip).
                  //   apparent_N = external·N − centripetal·N: pure apparent-force component
                  //   (user's framing for the centripetal-aware rule).
                  //   pullDemand = apparent_N + vN/dt: total required pull, also catching the
                  //   kinematic case where the body is already moving away (vN>0) faster than
                  //   grip can brake — equivalent to -aSurfaceNRequired.
                  // Grip budget along -N is the down-accel curve at current vN; at attached
                  // (vN≈0) it's downAccel.accelAtZero. If pullDemand exceeds the budget,
                  // detach. The reason string differentiates centripetal vs departing-body
                  // failures for diagnosability.
                  const apparentN = aExN - aCentripetalN;
                  const gripBudget_N = evaluateLinearAccel(profile.downAccel, Math.max(0, vN));
                  const pullDemand = apparentN + vN / dt;

                  // ----- State transitions (use REQUIRED, not capped, magnitudes) -----
                  const slipMag = Math.max(Math.abs(aReqF), Math.abs(aReqR));
                  let stateChanged = false;
                  if (aSurfaceNRequired > sample.normalInMax * profile.ragdollNormalInScale) {
                    // Surface stiffness exceeded — V1 has no ragdoll behavior yet, so detach to airborne.
                    setState(ctrl, "airborne", `smack: required normal-in ${aSurfaceNRequired.toFixed(0)} > ${(sample.normalInMax * profile.ragdollNormalInScale).toFixed(0)}`, now);
                    ctrl.locomotionMode = "volumeConstrained";
                    stateChanged = true;
                  } else if (pullDemand > gripBudget_N) {
                    const isCentripetal = Math.abs(apparentN) >= Math.abs(vN / dt);
                    const reason = isCentripetal
                      ? `detach: centripetal apparent_N=${apparentN.toFixed(2)} (v²·κ=${aCentripetalN.toFixed(2)}, aExN=${aExN.toFixed(2)}) > grip ${gripBudget_N.toFixed(2)}`
                      : `detach: departing vN=${vN.toFixed(2)} pull=${pullDemand.toFixed(2)} > grip ${gripBudget_N.toFixed(2)}`;
                    setState(ctrl, "airborne", reason, now);
                    ctrl.locomotionMode = "volumeConstrained";
                    stateChanged = true;
                    if (IS_DEV) {
                      // eslint-disable-next-line no-console
                      console.log(
                        `[CC ${id}] surfaceRun → airborne reason=${isCentripetal ? "centripetal" : "departing"} vN=${vN.toFixed(3)} aExN=${aExN.toFixed(2)} aCentripetalN=${aCentripetalN.toFixed(2)} apparent_N=${apparentN.toFixed(2)} pull=${pullDemand.toFixed(2)} grip=${gripBudget_N.toFixed(2)} uv=(${uv[0].toFixed(2)},${uv[1].toFixed(2)})`,
                      );
                    }
                  } else if (slipMag > gripBudget * profile.slideGripScale && ctrl.state === "surfaceRun") {
                    setState(ctrl, "surfaceSlide", "grip exceeded", now);
                  } else if (sample.slopeRad > profile.slopeRunMaxRad && ctrl.state === "surfaceRun") {
                    setState(ctrl, "surfaceSlide", `slope ${sample.slopeRad.toFixed(2)}>${profile.slopeRunMaxRad.toFixed(2)}`, now);
                  } else if (
                    ctrl.state === "surfaceSlide" &&
                    sample.slopeRad < profile.slopeStandMaxRad &&
                    Math.abs(vF) + Math.abs(vR) < 0.5
                  ) {
                    setState(ctrl, "surfaceRun", `slope eased to ${sample.slopeRad.toFixed(2)}`, now);
                  }

                  // ----- Add tangent control + surface reaction to the accumulator -----
                  // (Skip if we just detached — let airborne path run next tick.)
                  if (!stateChanged) {
                    accelEntry.accel[0] += aFEff * FtX + aREff * RtX + aSurfaceN * Nx;
                    accelEntry.accel[1] += aFEff * FtY + aREff * RtY + aSurfaceN * Ny;
                    accelEntry.accel[2] += aFEff * FtZ + aREff * RtZ + aSurfaceN * Nz;
                  }
                }

                // Jump: edge press → switch to airborne with an impulse along the
                // current SURFACE NORMAL (not world +Y). On flat ground N=+Y so this
                // matches the historical behavior; on a wall (concave wall-of-death)
                // it pushes the player AWAY from the wall toward the axis; on the
                // side of a horizontal-axis log it pushes them outward, etc.
                if (input.jumpPressed && ctrl.locomotionMode === "surfaceConstrained" && sample) {
                  v.linear[0] += profile.jumpImpulse * sample.normal[0];
                  v.linear[1] += profile.jumpImpulse * sample.normal[1];
                  v.linear[2] += profile.jumpImpulse * sample.normal[2];
                  ctrl.locomotionMode = "volumeConstrained";
                  setState(ctrl, "airborne", "jump pressed", now);
                }
              } else {
                // Air states: thrust in the plane PERPENDICULAR TO GRAVITY, not world XZ.
                // World-XZ targeting fights radial gravity volumes — the character would
                // hammer its velocity back into the world-XZ plane each tick, cancelling
                // gravity's horizontal component (e.g. on a horizontal-axis cylinder where
                // gravity points -Y near the top but -X near the side, the body would
                // never orbit). Gravity already lives in `accelEntry.accel`; build the
                // air-thrust basis around `up = -normalize(gravity)`.
                const gx = accelEntry.accel[0];
                const gy = accelEntry.accel[1];
                const gz = accelEntry.accel[2];
                const gLen = Math.hypot(gx, gy, gz);
                let upX = 0, upY = 1, upZ = 0;
                if (gLen > 1e-6) {
                  upX = -gx / gLen; upY = -gy / gLen; upZ = -gz / gLen;
                }

                // Camera forward in world XZ (same convention as the surface branch).
                const sy = Math.sin(input.cameraYaw), cy = Math.cos(input.cameraYaw);
                let FwX = -sy, FwY = 0, FwZ = -cy;
                // Project camera forward onto the plane perpendicular to `up`, normalize.
                const FdotUp = FwX * upX + FwY * upY + FwZ * upZ;
                FwX -= FdotUp * upX;
                FwY -= FdotUp * upY;
                FwZ -= FdotUp * upZ;
                let FwLen = Math.hypot(FwX, FwY, FwZ);
                if (FwLen < 1e-6) {
                  // Degenerate: camera-fwd is parallel to up (looking straight up/down).
                  // Pick any consistent perpendicular — fall back to world +X minus its
                  // up-component, normalized.
                  FwX = 1; FwY = 0; FwZ = 0;
                  const FdotUp2 = FwX * upX + FwY * upY + FwZ * upZ;
                  FwX -= FdotUp2 * upX; FwY -= FdotUp2 * upY; FwZ -= FdotUp2 * upZ;
                  FwLen = Math.hypot(FwX, FwY, FwZ) || 1;
                }
                FwX /= FwLen; FwY /= FwLen; FwZ /= FwLen;
                // Right = Fw × up (unit since both are unit and orthogonal).
                const RtX = FwY * upZ - FwZ * upY;
                const RtY = FwZ * upX - FwX * upZ;
                const RtZ = FwX * upY - FwY * upX;

                // Desired velocity vector in the air-thrust plane.
                const desiredVX = (FwX * input.moveY + RtX * input.moveX) * profile.airSpeedCap;
                const desiredVY = (FwY * input.moveY + RtY * input.moveX) * profile.airSpeedCap;
                const desiredVZ = (FwZ * input.moveY + RtZ * input.moveX) * profile.airSpeedCap;

                // Project current velocity onto the same plane (drop the gravity-aligned
                // component); thrust closes the gap between projected velocity and
                // desired, capped at airAccel. ADD to accumulator — let volumetric
                // integrate it together with gravity.
                const vDotUp = v.linear[0] * upX + v.linear[1] * upY + v.linear[2] * upZ;
                const vHorizX = v.linear[0] - vDotUp * upX;
                const vHorizY = v.linear[1] - vDotUp * upY;
                const vHorizZ = v.linear[2] - vDotUp * upZ;
                const dvX = desiredVX - vHorizX;
                const dvY = desiredVY - vHorizY;
                const dvZ = desiredVZ - vHorizZ;
                // accel = clamp(dv/dt, airAccel). Cap the magnitude of the (3D) thrust
                // vector, not per-axis, so diagonal thrust isn't √2 stronger than axial.
                let aThX = dvX / dt;
                let aThY = dvY / dt;
                let aThZ = dvZ / dt;
                const aThMag = Math.hypot(aThX, aThY, aThZ);
                if (aThMag > profile.airAccel) {
                  const s = profile.airAccel / aThMag;
                  aThX *= s; aThY *= s; aThZ *= s;
                }
                accelEntry.accel[0] += aThX;
                accelEntry.accel[1] += aThY;
                accelEntry.accel[2] += aThZ;
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

/** Maximum number of recent transitions we keep on the controller for the HUD. */
const TRANSITION_LOG_LIMIT = 12;

/** Record a state transition: mutates ctrl, pushes a ControllerTransition into its ring buffer.
 *  Exported so other systems (surfaceConstraint's walked-off-edge / landed paths) use the same
 *  pattern and the debug HUD sees every state change. `now` is the scheduler's `now` for timestamping. */
export function recordTransition(
  ctrl: CharacterControllerComponent,
  next: ControllerState,
  reason: string,
  now: number,
): void {
  if (ctrl.state === next) return;
  const from = ctrl.state;
  ctrl.state = next;
  ctrl.lastTransitionReason = reason;
  ctrl.timeInState = 0;
  ctrl.transitions.push({ from, to: next, locomotion: ctrl.locomotionMode, t: now, reason });
  if (ctrl.transitions.length > TRANSITION_LOG_LIMIT) ctrl.transitions.shift();
}

function setState(
  ctrl: CharacterControllerComponent,
  next: ControllerState,
  reason: string,
  now: number,
): void {
  recordTransition(ctrl, next, reason, now);
}

/**
 * Clamp `value` into [lo, hi]. Handles inverted ranges (lo > hi) by returning the
 * midpoint of the inversion — physically this happens when "max forward thrust"
 * AND "max backward thrust" both went negative (extreme over-speed in both
 * directions, impossible for a single 1D velocity but the math survives).
 */
function clampToRange(value: number, lo: number, hi: number): number {
  if (lo > hi) return (lo + hi) * 0.5;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
