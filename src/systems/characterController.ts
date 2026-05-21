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
  CHARACTER_CONTROLLER_DEBUG_BUFFER_ID,
  type CharacterControllerDebugBufferData,
} from "../buffers/characterControllerDebug";
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
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../buffers/volumeField";
import { pickGravity, sortVolumesByPriority } from "../lib/math/gravityVolume";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { TANGENT_INPUT_MAPPER_SYSTEM_ID } from "./tangentInputMapper";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";
import { evaluateLinearAccel } from "../lib/math/accelCurve";
import { heldImpulseProgress } from "../lib/math/heldImpulse";
import { projectCameraTangentForward } from "../lib/math/cameraTangent";
import type { Vec3 } from "../lib/math/quat";
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
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: CHARACTER_CONTROLLER_DEBUG_BUFFER_ID, access: "readwrite" },
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
      const vol = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));
      const sortedVolumes = sortVolumesByPriority(vol.volumes);
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const faBuf = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);
      const dbgBuf = buffer<CharacterControllerDebugBufferData>(CHARACTER_CONTROLLER_DEBUG_BUFFER_ID);
      // Cheap pre-check: if disabled, the per-tick capture branch is skipped entirely
      // and production pays only a single bool read per execute(). When enabled, the
      // tick counter is the existing `now` (scheduler ms) — diagnostic rows are tagged
      // with it so the baseline JSON shows when each row was captured.
      const dbgEnabled = readBuffer(dbgBuf).enabled;

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

              if (
                ctrl.state === "surfaceRun" ||
                ctrl.state === "surfaceSlide" ||
                ctrl.state === "climb"
              ) {
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

                  // Slope relative to LOCAL GRAVITY, not world-Y. `sample.slopeRad`
                  // would tell us "how steep is this surface compared to flat
                  // ground" — which is wrong under radial / cylindrical gravity
                  // where "flat ground" rotates with the gravity field. cos(slope)
                  // = (−gravityUnit · N) = −aExN / |aEx|, computed from the
                  // accumulator that ForceField just wrote (gravity is its dominant
                  // contributor; per-tick external impulses average out). On the
                  // Mario-Galaxy sphere this returns slope=0 at the equator instead
                  // of π/2; on flat-gravity worlds it collapses back to
                  // sample.slopeRad's value.
                  const aExMag = Math.hypot(accelEntry.accel[0], accelEntry.accel[1], accelEntry.accel[2]);
                  const slopeRad_local = aExMag > 1e-6
                    ? Math.acos(Math.max(-1, Math.min(1, -aExN / aExMag)))
                    : sample.slopeRad;

                  // ----- Required VOLUNTARY accel to reach desired (this tick) -----
                  // aReqNet = (vDes − v)/dt; aReqVoluntary = aReqNet − aEx.
                  const aReqF = (vDesF - vF) / dt - aExF;
                  const aReqR = (vDesR - vR) / dt - aExR;

                  // ----- Per-state curve bundle selection -----
                  // The curve bundle is selected by FSM state: climb uses
                  // `profile.climb.*` (low vMax, high accelAtZero) so the body grips
                  // and moves slowly on steep surfaces; everything else uses the
                  // top-level run curves. Same selection happens in
                  // TangentInputMapperSystem for `vDes` consistency.
                  // See [[worldgen-demo-controller-state-curves-and-triggers]].
                  const curves = ctrl.state === "climb" ? profile.climb : profile;

                  // ----- Friction grip = μ × |effective normal force| -----
                  // Effective normal force = external into-surface component (gravity)
                  // + body's self-applied push into the surface (`downAccel` curve, the
                  // -N axis of the 6DoF profile). Run sets downAccel=0 — legs aren't
                  // pressing into the ground; gravity supplies all the normal load.
                  // Climb sets it high (≈20 m/s²) — legs actively press into the wall
                  // to generate friction grip on near-vertical / overhang surfaces
                  // where gravity's into-N component alone is ~0. The same downAccel
                  // curve feeds the detach-resist rule below — it's the unified
                  // "force into -N" channel for the body.
                  const selfNormalPush = evaluateLinearAccel(curves.downAccel, Math.max(0, vN));
                  const gripBudget = sample.friction * (Math.abs(aExN) + selfNormalPush);

                  // ----- Per-direction biomechanical ceilings -----
                  // Each ceiling is the maximum voluntary thrust the character's limbs can
                  // produce IN THAT DIRECTION at the current per-direction speed projection.
                  // Past vMax in that direction, the curve goes negative — "limbs are too slow
                  // to push at this speed; they drag." Voluntary range = [−backCeil, +fwdCeil],
                  // intersected with friction grip on both sides.
                  const fwdCeil  = evaluateLinearAccel(curves.forwardAccel,  Math.max(0,  vF));
                  const backCeil = evaluateLinearAccel(curves.backwardAccel, Math.max(0, -vF));
                  const rightCeil = evaluateLinearAccel(curves.lateralAccel, Math.max(0,  vR));
                  const leftCeil  = evaluateLinearAccel(curves.lateralAccel, Math.max(0, -vR));
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
                  // Grip budget along -N uses the state-selected curve: climb's
                  // cranked downAccel (≈20 m/s², > gravity) is what holds the
                  // body to walls and overhangs — no separate grip mechanism.
                  const gripBudget_N = evaluateLinearAccel(curves.downAccel, Math.max(0, vN));
                  const pullDemand = apparentN + vN / dt;

                  // ----- State transitions -----
                  // Detach triggers (smack / pullDemand-exceeds-grip) fire from
                  // ANY surface state. Per-state transitions follow.
                  //
                  // All trigger conditions reduce to three local quantities:
                  //   - tangentSpeed (||(vF, vR)||)
                  //   - slopeRad_local (angle between N and -gravity)
                  //   - the player's intent vs net producible accel in that
                  //     direction (backslide criterion below).
                  // See [[worldgen-demo-fsm-transitions-as-the-primary-mechanic]].
                  const tangentSpeed = Math.hypot(vF, vR);
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
                        `[CC ${id}] ${ctrl.state} → airborne reason=${isCentripetal ? "centripetal" : "departing"} vN=${vN.toFixed(3)} aExN=${aExN.toFixed(2)} aCentripetalN=${aCentripetalN.toFixed(2)} apparent_N=${apparentN.toFixed(2)} pull=${pullDemand.toFixed(2)} grip=${gripBudget_N.toFixed(2)} uv=(${uv[0].toFixed(2)},${uv[1].toFixed(2)})`,
                      );
                    }
                  } else if (
                    (ctrl.state === "surfaceRun" || ctrl.state === "surfaceSlide") &&
                    tangentSpeed < profile.climb.engagementMaxSpeed &&
                    slopeRad_local > profile.slopeRunMaxRad
                  ) {
                    // Climb engagement: stopped (or nearly so) on a steep face → grab.
                    // Fires from run AND slide so a high-speed scramble that bleeds
                    // its tangent speed into a wall transitions into climb. The
                    // cranked `profile.climb.downAccel` IS the grip mechanism —
                    // existing centripetal-leave rule reads it, body sticks.
                    setState(
                      ctrl,
                      "climb",
                      `grab: tangentSpeed ${tangentSpeed.toFixed(2)} < ${profile.climb.engagementMaxSpeed.toFixed(2)} on slope ${slopeRad_local.toFixed(2)}`,
                      now,
                    );
                  } else if (
                    ctrl.state === "climb" &&
                    slopeRad_local < profile.slopeStandMaxRad
                  ) {
                    // Climb disengagement: slope eased to a runnable angle. Use
                    // slopeStandMaxRad (the slide→run hysteresis threshold) so
                    // run⇄climb doesn't oscillate around slopeRunMaxRad.
                    setState(
                      ctrl,
                      "surfaceRun",
                      `slope eased to ${slopeRad_local.toFixed(2)} < ${profile.slopeStandMaxRad.toFixed(2)}`,
                      now,
                    );
                  } else if (
                    ctrl.state === "climb" &&
                    tangentSpeed > profile.climb.engagementMaxSpeed * 1.5
                  ) {
                    // Lost grip via external impulse: climb max speed exceeded by
                    // 1.5× → drop into slide so friction-dominated path takes over.
                    // The bare engagementMaxSpeed is the engagement gate; the
                    // 1.5× hysteresis prevents oscillation.
                    setState(
                      ctrl,
                      "surfaceSlide",
                      `climb cap blown: tangentSpeed ${tangentSpeed.toFixed(2)} > ${profile.climb.engagementMaxSpeed.toFixed(2)}`,
                      now,
                    );
                  } else if (
                    ctrl.state === "surfaceRun" &&
                    tangentSpeed > profile.forwardAccel.vMax * 1.1
                  ) {
                    // Over-speed slide trigger: tangentSpeed past the natural
                    // top-speed limit (forwardAccel's x-intercept) means "limbs
                    // can't cycle that fast — friction takes over." Should only
                    // fire when an external impulse pushed us past vMax (e.g.
                    // jumping into a steep slope and converting vertical to
                    // tangent). 1.1× margin so normal acceleration overshoots
                    // don't trip it.
                    setState(
                      ctrl,
                      "surfaceSlide",
                      `over-speed: tangentSpeed ${tangentSpeed.toFixed(2)} > ${profile.forwardAccel.vMax.toFixed(2)}`,
                      now,
                    );
                  } else if (
                    ctrl.state === "surfaceSlide" &&
                    tangentSpeed < profile.forwardAccel.vMax * 1.05
                  ) {
                    // Passive slide recovery — hysteresis above vMax.
                    //
                    // Entry threshold (overspeed trigger above): vF > 1.10·vMax.
                    // Exit threshold (this branch):              vF < 1.05·vMax.
                    //
                    // BOTH thresholds sit above vMax, with 5% margin between
                    // them — user-directed 2026-05-21 after diagnostic on
                    // camera-hill-crest-extended showed the body decelerates
                    // along the SHIFTED equilibrium (vDes = (40+aExF)/5 on
                    // downhill), so it never drops cleanly below vMax until
                    // the slope is essentially flat. With exit at vMax (1.0·)
                    // the body would sit at exactly 8.00 m/s in slide forever;
                    // with exit at 1.05·vMax it returns to surfaceRun while
                    // still on the descent, before the long flat-ground tail.
                    //
                    // The shifted-vDes equilibrium behavior (forwardAccel curve
                    // shifted by aExF, body cruising at the natural terminal
                    // speed for the current slope) is preserved — this change
                    // only moves where the FSM transitions in/out of slide.
                    //
                    // Per [[worldgen-demo-slip-criteria-2026-05-18]] +
                    // [[worldgen-demo-6dof-curves-are-the-grip-mechanism]] —
                    // the natural condition for slide is "speed exceeds the
                    // limb-cycle cap." Once the speed is within ~5% of vMax
                    // the limbs can keep up; body should be in surfaceRun.
                    setState(
                      ctrl,
                      "surfaceRun",
                      `recover: tangentSpeed ${tangentSpeed.toFixed(2)} < ${(profile.forwardAccel.vMax * 1.05).toFixed(2)}`,
                      now,
                    );
                  } else if (ctrl.state === "surfaceRun" || ctrl.state === "surfaceSlide") {
                    // Backslide trigger: player is pressing in some direction AND
                    // velocity is in the opposing direction AND the max producible
                    // net acceleration in the intent direction (foot ceiling +
                    // external) is ≤ 0. That's the user's "actively accelerating
                    // the other way" — feet maxed out, external winning. NOTE:
                    // foot ceilings are signed (positive = thrust in that
                    // direction); when intent has a +Y component we project the
                    // forward ceiling onto Y, etc. We use the *capped* ceilings
                    // (gripBudget-intersected) because that's the actual force
                    // available, not just the biomechanical max.
                    const intentMagSq = input.moveX * input.moveX + input.moveY * input.moveY;
                    if (intentMagSq > 0.04) {
                      // Per-axis max foot ceiling in the intent's sign.
                      const intentDirF =
                        input.moveY > 0 ? fwdMax : input.moveY < 0 ? -backMax : 0;
                      const intentDirR =
                        input.moveX > 0 ? rightMax : input.moveX < 0 ? -leftMax : 0;
                      // Net producible accel along intent direction =
                      // (max foot ceil + external) · intent_unit.
                      const intentLen = Math.sqrt(intentMagSq);
                      const intentNet =
                        ((intentDirF + aExF) * input.moveY +
                          (intentDirR + aExR) * input.moveX) /
                        intentLen;
                      // Velocity component along intent — backslide requires this
                      // to be negative (moving against intent).
                      const vAlongIntent =
                        (vF * input.moveY + vR * input.moveX) / intentLen;
                      if (
                        intentNet <= 0 &&
                        vAlongIntent < -0.1 &&
                        ctrl.state === "surfaceRun"
                      ) {
                        setState(
                          ctrl,
                          "surfaceSlide",
                          `backslide: intentNet ${intentNet.toFixed(2)} ≤ 0, vAlongIntent ${vAlongIntent.toFixed(2)}`,
                          now,
                        );
                      }
                    }
                  }

                  // Diagnostic capture (opt-in via CharacterControllerDebugBuffer.enabled).
                  // Gated on a single bool read so production cost is negligible.
                  // Captures every intermediate the surface-frame solver computes; the
                  // buffer-snapshot regression framework compares histories tick-for-tick.
                  if (dbgEnabled) {
                    const tForDebug = readBuffer(tBuf).byEntity.get(id);
                    const pX = tForDebug ? tForDebug.position[0] : 0;
                    const pY = tForDebug ? tForDebug.position[1] : 0;
                    const pZ = tForDebug ? tForDebug.position[2] : 0;
                    const vX = v.linear[0];
                    const vY = v.linear[1];
                    const vZ = v.linear[2];
                    writeBuffer(dbgBuf, (d) => {
                      let entry = d.byEntity.get(id);
                      if (!entry) {
                        entry = { history: [] };
                        d.byEntity.set(id, entry);
                      }
                      entry.history.push({
                        tick: now,
                        vF, vR, vN,
                        slopeRad: slopeRad_local,
                        aExN, aExF, aExR,
                        aCentripetalN,
                        gripBudget,
                        gripBudget_N,
                        fwdCeil, backCeil, rightCeil, leftCeil,
                        fwdMax, backMax, rightMax, leftMax,
                        aReqF, aReqR,
                        aFEff, aREff,
                        aSurfaceNRequired,
                        aSurfaceN,
                        apparentN,
                        pullDemand,
                        selfNormalPush,
                        tangentSpeed,
                        posX: pX, posY: pY, posZ: pZ,
                        velX: vX, velY: vY, velZ: vZ,
                      });
                    });
                  }

                  // ----- Add ONLY tangent control to the accumulator -----
                  // (Skip if we just detached — let airborne path run next tick.)
                  //
                  // We intentionally do NOT add `aSurfaceN * N` to the accumulator.
                  // Why: the surface constraint pins the body to the surface
                  // geometrically (surfaceConstrainedVelocity step 5 sets
                  // pos = sample_new.position + radius·N). The body doesn't need a
                  // "surface reaction" force on its velocity buffer to stay attached.
                  //
                  // Worse, adding aSurfaceN to the accumulator was actively harmful:
                  // when `aCentripetalN` spikes at heightmap tile borders (curvature
                  // of the bilinear height field is impulsive at C¹ discontinuities),
                  // `aSurfaceN` spikes to match the centripetal demand. Adding that
                  // to the accumulator injects huge normal-direction velocity that
                  // step 6 of surfaceConstrainedVelocity dutifully projects out — but
                  // step 7 then rescales the remaining tangent magnitude back up to
                  // the post-step-1 speed, converting the projected-out normal
                  // kinetic into TANGENT kinetic energy. The visible symptom is the
                  // body "shooting up" the wall at the first tile transition.
                  //
                  // The textbook physics is clear: centripetal force is normal-aligned
                  // and never adds to tangent velocity. It contributes to friction
                  // (since friction = μ × |normal_force|) and to the detach criterion
                  // (since the surface needs to provide that pull to hold the body),
                  // and that's it. Both of those uses are preserved above —
                  // `aSurfaceN` / `aSurfaceNRequired` are still computed for the
                  // ragdoll + detach checks; they just no longer touch the velocity.
                  //
                  // See [[worldgen-demo-aSurfaceN-out-of-accumulator-2026-05-19]] and
                  // the bisect trace in the conversation log.
                  if (!stateChanged) {
                    accelEntry.accel[0] += aFEff * FtX + aREff * RtX;
                    accelEntry.accel[1] += aFEff * FtY + aREff * RtY;
                    accelEntry.accel[2] += aFEff * FtZ + aREff * RtZ;
                  }
                }

                // Jump press: capture the "intended jump velocity" by blending
                // current horizontal velocity with the joystick direction, plus
                // a fixed vertical component along the surface normal. The
                // difference from current velocity is the total impulse the
                // jump owes; we apply step 1 immediately and stash the
                // direction + budget on the controller for the hold-window
                // integration that runs each subsequent tick. Direction is
                // locked at press; gravity bends the trajectory afterwards.
                if (input.jumpPressed && ctrl.locomotionMode === "surfaceConstrained") {
                  // Press-time intent. Two rules:
                  //
                  //  1. **Vertical = gravity-up**, NOT surface normal. Jumping
                  //     off an incline should kick toward the sky, not normal
                  //     to the slope (which points partway "back down"
                  //     relative to gravity). Gravity-up = -normalize(pickGravity).
                  //
                  //  2. **Horizontal kick = joystick** mapped through the
                  //     CAMERA-on-gravity-horizon plane, ADDED to current
                  //     velocity. Surface tangent is not the intent basis —
                  //     it only constrains the result via clamp #3 below.
                  //     "Running along a wall + jump right" = forward
                  //     velocity preserved + lateral kick.
                  //
                  //  3. **Tangent-plane clamp**: impulse is projected so it
                  //     never pushes INTO the surface (-N component zeroed).
                  //     On a wall this redirects the kick to be at most
                  //     tangent to the wall instead of crashing through it.
                  //
                  //  4. **Surface-friction scale**: the kick magnitude is
                  //     scaled by how aligned the surface normal is with
                  //     gravity-up. Full on flat ground, reduced on slopes,
                  //     minimum on vertical walls — "last push up the wall,
                  //     not a leap to scale it."
                  const jpAtt = sa.byEntity.get(id);
                  if (jpAtt && jpAtt.sample) {
                    const sp_ = jpAtt.sample.position;
                    const grav = pickGravity(sortedVolumes, vol.gravity, [sp_[0], sp_[1], sp_[2]]);
                    const gLen = Math.hypot(grav[0], grav[1], grav[2]) || 1;
                    const gUpX = -grav[0] / gLen, gUpY = -grav[1] / gLen, gUpZ = -grav[2] / gLen;

                    // Joystick basis in the camera-on-gravity-horizon plane
                    // (reuses projectCameraTangentForward with N = gUp).
                    const camF: Vec3 = [
                      input.cameraLookDir[0], input.cameraLookDir[1], input.cameraLookDir[2],
                    ];
                    const camU: Vec3 = [
                      input.cameraUp[0], input.cameraUp[1], input.cameraUp[2],
                    ];
                    const horizon = projectCameraTangentForward(camF, camU, [gUpX, gUpY, gUpZ]);
                    const horizF = horizon.forward;
                    const horizR = horizon.right;

                    const moveX = input.moveX, moveY = input.moveY;
                    const stickMag = Math.min(1, Math.hypot(moveX, moveY));

                    // Additive impulse: vertical component along gravity-up +
                    // (optional) horizontal kick in joystick direction.
                    // Current velocity is preserved; the kick is added to it
                    // by the downstream `v.linear += dir × stepSize` step.
                    let impX = gUpX * profile.jump.upSpeed;
                    let impY = gUpY * profile.jump.upSpeed;
                    let impZ = gUpZ * profile.jump.upSpeed;
                    if (stickMag > 1e-6 && horizF && horizR) {
                      const jX = moveY * horizF[0] + moveX * horizR[0];
                      const jY = moveY * horizF[1] + moveX * horizR[1];
                      const jZ = moveY * horizF[2] + moveX * horizR[2];
                      const jLen = Math.hypot(jX, jY, jZ) || 1;
                      const kick = stickMag * profile.jump.horizSpeed;
                      impX += (jX / jLen) * kick;
                      impY += (jY / jLen) * kick;
                      impZ += (jZ / jLen) * kick;
                    }

                    // Clamp 1 (surface tangent): impulse must not push INTO
                    // the slope. Project out any -N component so the impulse
                    // is at worst tangent to the surface. Behavioural effect:
                    // - Pressing into a 70° wall + jump → impulse goes UP
                    //   the wall (tangent) instead of crashing through it.
                    // - Pressing into a too-steep hill + jump → impulse
                    //   redirects up-along-the-slope (climb-style push).
                    const jpN = jpAtt.sample.normal;
                    const ipDotN = impX * jpN[0] + impY * jpN[1] + impZ * jpN[2];
                    if (ipDotN < 0) {
                      impX -= ipDotN * jpN[0];
                      impY -= ipDotN * jpN[1];
                      impZ -= ipDotN * jpN[2];
                    }

                    // Clamp 2 (max angle below horizon): impulse direction
                    // can't dive more than `maxAngleBelowHorizonRad` below
                    // world horizontal. Default 10° — enables wall-to-wall
                    // ricochet jumps that go slightly downward, but you
                    // never "jump down" steeply.
                    let impMag = Math.hypot(impX, impY, impZ);
                    if (impMag > 1e-6) {
                      const minVertFrac = -Math.sin(profile.jump.maxAngleBelowHorizonRad);
                      const minVertVal = minVertFrac * impMag;
                      const ipDotGUp = impX * gUpX + impY * gUpY + impZ * gUpZ;
                      if (ipDotGUp < minVertVal) {
                        // Decompose into world-horizontal + gravity-vertical;
                        // set vertical to the floor, scale horizontal to keep
                        // total magnitude unchanged. Rotates the impulse up
                        // to exactly the clamp boundary.
                        const horizX = impX - ipDotGUp * gUpX;
                        const horizY = impY - ipDotGUp * gUpY;
                        const horizZ = impZ - ipDotGUp * gUpZ;
                        const horizMag = Math.hypot(horizX, horizY, horizZ) || 1;
                        const newHorizMag = Math.cos(profile.jump.maxAngleBelowHorizonRad) * impMag;
                        const s = newHorizMag / horizMag;
                        impX = horizX * s + minVertVal * gUpX;
                        impY = horizY * s + minVertVal * gUpY;
                        impZ = horizZ * s + minVertVal * gUpZ;
                        impMag = Math.hypot(impX, impY, impZ);
                      }
                    }

                    // Surface-availability scale: applied ONLY to the tangent
                    // component of the impulse (the part PARALLEL to the
                    // wall surface). The legs push away from the surface
                    // with their full normal force; what's reduced on
                    // slopes is the tangent push — that's the friction-
                    // limited part, and friction is mostly spent holding
                    // against tangent gravity on a wall. "Last push up the
                    // wall" affects the up-along-wall component, not the
                    // out-from-wall component.
                    const NdotGUp = jpN[0] * gUpX + jpN[1] * gUpY + jpN[2] * gUpZ;
                    const surfaceScale = Math.max(profile.jump.minSurfaceScale, NdotGUp);
                    const ipDotN2 = impX * jpN[0] + impY * jpN[1] + impZ * jpN[2];
                    const impNX = ipDotN2 * jpN[0];
                    const impNY = ipDotN2 * jpN[1];
                    const impNZ = ipDotN2 * jpN[2];
                    const impTX = (impX - impNX) * surfaceScale;
                    const impTY = (impY - impNY) * surfaceScale;
                    const impTZ = (impZ - impNZ) * surfaceScale;
                    impX = impNX + impTX;
                    impY = impNY + impTY;
                    impZ = impNZ + impTZ;
                    impMag = Math.hypot(impX, impY, impZ);

                    if (impMag > 1e-6) {
                      const dirX = impX / impMag;
                      const dirY = impY / impMag;
                      const dirZ = impZ / impMag;
                      const nSteps = Math.max(1, profile.jump.stepCount);
                      const stepSize = impMag / nSteps;
                      v.linear[0] += dirX * stepSize;
                      v.linear[1] += dirY * stepSize;
                      v.linear[2] += dirZ * stepSize;
                      ctrl.jumpHolding = true;
                      ctrl.jumpDir = [dirX, dirY, dirZ];
                      ctrl.jumpImpulseMagMax = impMag;
                      ctrl.jumpImpulseApplied = stepSize;
                    }
                  }
                  ctrl.locomotionMode = "volumeConstrained";
                  setState(ctrl, "airborne", "jump pressed", now);
                }
              } else {
                // Jump hold-window: while the jump button is held within
                // `profile.jumpHoldMaxSec` of the press, integrate the
                // remaining impulse along the locked `ctrl.jumpDir`. The
                // progress kernel (`heldImpulseProgress`) is frame-rate-
                // independent and supports step-snapping for predictable
                // press-timing. Direction was captured at press in the
                // surface branch above; gravity bends the trajectory
                // naturally afterwards.
                if (ctrl.jumpHolding) {
                  const progress = heldImpulseProgress(
                    ctrl.timeInState,
                    profile.jump.holdMaxSec,
                    profile.jump.stepCount,
                  );
                  const targetImpulse = progress * ctrl.jumpImpulseMagMax;
                  const delta = targetImpulse - ctrl.jumpImpulseApplied;
                  if (delta > 0) {
                    v.linear[0] += ctrl.jumpDir[0] * delta;
                    v.linear[1] += ctrl.jumpDir[1] * delta;
                    v.linear[2] += ctrl.jumpDir[2] * delta;
                    ctrl.jumpImpulseApplied = targetImpulse;
                  }
                  if (input.jumpReleased || ctrl.timeInState >= profile.jump.holdMaxSec || progress >= 1) {
                    ctrl.jumpHolding = false;
                  }
                }

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
