import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../buffers/forceAccumulator";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  CHARACTER_INPUT_BUFFER_ID,
  type CharacterInputBufferData,
} from "../buffers/characterInput";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import {
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../buffers/surfaceAttachment";
import {
  SURFACE_PROVIDER_BUFFER_ID,
  type SurfaceProviderBufferData,
} from "../buffers/surfaceProvider";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { assertDev, warnDev } from "../runtime/dev";
import { HeightmapSurfaceProvider } from "../world/surfaceProvider";
import { sweepCircleVsSegment, TAU_MIN } from "../lib/math/sweptCircleSegment";
import {
  SURFACE_CONSTRAINED_VELOCITY_DEBUG_BUFFER_ID,
  type SurfaceConstrainedVelocityDebugBufferData,
} from "../buffers/surfaceConstrainedVelocityDebug";

/** Maximum iterations of the corner-jump loop per tick. Hitting this is
 *  a soft flag (warnDev + counter), not a hard error — could legitimately
 *  mean a fast-moving disc crossed many segments in one tick. */
const CORNER_JUMP_MAX_ITERATIONS = 16;
/** Below this horizontal foot motion (m), the velocity plane is ill-
 *  defined; CCD is skipped and UV-led result stands. */
const CORNER_JUMP_MIN_HORIZONTAL_FOOT_DELTA = 1e-4;
/** Profile half-window (m) behind the foot start. Covers disc radius +
 *  safety. */
const CORNER_JUMP_PROFILE_HALF_BACK = 0.75;
/** Profile sample step (m). Smaller than typical heightmap cell so
 *  segment boundaries are resolved. */
const CORNER_JUMP_PROFILE_STEP = 0.25;

export const SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID = "surfaceConstrainedVelocitySystem";

/**
 * UV-space integration for surface-attached characters.
 *
 * The body is constrained to the surface — its world position is always derived from
 * `sample(uv) + radius · sample(uv).normal` each tick. Velocity is in world XYZ but
 * advanced in UV space via the tangent-frame projection, which keeps the body's normal
 * velocity component implicitly zero.
 *
 * Per-tick math:
 *   1. Integrate world velocity: vel += accumulator.accel · dt.
 *   2. Advance UV via velocity projected onto sample.tangent / |tangent| · dt.
 *      Closed surfaces wrap; open surfaces are clamped (out-of-bounds detected by
 *      `surfaceConstraintSystem` via the un-clamped UV).
 *   3. Sample the surface at the new UV → new world position + tangent frame.
 *   4. World position = sample_new.position + radius · sample_new.normal.
 *   5. Drop velocity's normal component along sample_new.normal (smooth-roll
 *      constraint reaction). Multi-contact corner velocity transfer
 *      (`profile.cornerTransferEfficiency`, magnitude-preserving rotation onto the
 *      new contact's tangent) is a separate path — disc-vs-segment CCD against the
 *      piecewise-linear profile in the velocity plane — not yet implemented.
 */
export function createSurfaceConstrainedVelocitySystem(): SystemDescriptor {
  return {
    id: SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID,
    description:
      "UV-space integration for surface-attached characters. Projects world velocity & accel onto the surface tangent frame, integrates in UV via semi-implicit Euler, derives new world position from the integrated UV (sample + radius·N), and reconstructs world velocity from the new tangent frame. Eliminates the XYZ-then-snap pattern and its bug class (mesa-snap, cliff-snap, cylinder-embed).",
    buffers: [
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_INPUT_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "readwrite" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
      { id: SURFACE_CONSTRAINED_VELOCITY_DEBUG_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_CONTROLLER_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const ci = readBuffer(buffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const sp = readBuffer(buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID));
      const surface = sp.heightmap;
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const saBuf = buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);
      const dbgBuf = buffer<SurfaceConstrainedVelocityDebugBufferData>(SURFACE_CONSTRAINED_VELOCITY_DEBUG_BUFFER_ID);
      const accels = readBuffer(fa);
      const dbgEnabled = readBuffer(dbgBuf).enabled;

      // If there are any surface-attached entities, a SurfaceProvider must be registered.
      // Silent fallback to XYZ integration here would mask the very class of bugs B.3
      // exists to eliminate. See `wiki/worldgen-demo-no-silent-fallbacks-in-tests.md`.
      const anySurfaceAttached = (() => {
        for (const ctrl of cc.byEntity.values()) {
          if (ctrl.locomotionMode === "surfaceConstrained") return true;
        }
        return false;
      })();
      assertDev(
        !anySurfaceAttached || surface !== null,
        "surfaceConstrainedVelocity: a surfaceConstrained entity exists but SurfaceProviderBuffer.heightmap is null — register a SurfaceProvider before integrating.",
      );
      if (!surface) return; // no surface-attached entities AND no provider → nothing to do

      writeBuffer(vBuf, (vels) => {
        writeBuffer(tBuf, (transforms) => {
          writeBuffer(saBuf, (atts) => {
            for (const [id, ctrl] of cc.byEntity) {
              if (ctrl.locomotionMode !== "surfaceConstrained") continue;
              const att = atts.byEntity.get(id);
              const vel = vels.byEntity.get(id);
              const t = transforms.byEntity.get(id);
              const profile = profiles.byId.get(ctrl.profileId);
              if (!att || !vel || !t || !profile) continue;
              const sample = att.sample;
              if (!sample) continue; // attachment must carry a sample to integrate against
              const radius = profile.bodyRadius;

              // Snapshot pre-integration world velocity for downstream consumers
              // (chain dynamics, hit reactions, future ragdoll triggers).
              vel.prevLinear[0] = vel.linear[0];
              vel.prevLinear[1] = vel.linear[1];
              vel.prevLinear[2] = vel.linear[2];

              // Save body's pre-tick world position. If the corner-jump
              // CCD transitions contact discretely this tick, we'll
              // reset att.contactOffset to (bodyPre − newContact) to
              // preserve body position across the otherwise-discontinuous
              // contact jump (user 2026-05-23).
              const bodyPreX = t.position[0];
              const bodyPreY = t.position[1];
              const bodyPreZ = t.position[2];
              if (!att.contactOffset) att.contactOffset = [0, radius, 0];
              // Per-entity scope — flipped to true inside the corner-jump
              // CCD if the disc transferred to a new contact segment.
              let contactTransferred = false;

              // Diagnostic capture (cheap when disabled — local locals).
              const dbg = {
                velStartX: vel.linear[0], velStartY: vel.linear[1], velStartZ: vel.linear[2],
                nPreX: sample.normal[0], nPreY: sample.normal[1], nPreZ: sample.normal[2],
                velAfterAccelX: 0, velAfterAccelY: 0, velAfterAccelZ: 0,
                velAfterCornerJumpX: 0, velAfterCornerJumpY: 0, velAfterCornerJumpZ: 0,
                dhX: 0, dhZ: 0, hLen: 0, cornerJumped: false, cornerJumpIters: 0,
                profileVertCount: 0, profileMaxSin: 0,
              };

              // Integration: keep world velocity as the primary state and project onto
              // the surface each step. The tangent-frame-scalar form (vTanU·tangentU +
              // vTanV·tangentV) is energy-conserving ONLY when the tangents are
              // orthogonal — but on a heightmap with non-zero gradients in BOTH u and v,
              // tangentU·tangentV ≠ 0, and reconstruction injects spurious energy via
              // the cross term. This formulation avoids the decomposition entirely.
              //
              // Step 1: read accumulator accel; integrate world velocity (semi-implicit Euler).
              const a = accels.byEntity.get(id);
              if (a) {
                vel.linear[0] += a.accel[0] * dt;
                vel.linear[1] += a.accel[1] * dt;
                vel.linear[2] += a.accel[2] * dt;
              }
              dbg.velAfterAccelX = vel.linear[0];
              dbg.velAfterAccelY = vel.linear[1];
              dbg.velAfterAccelZ = vel.linear[2];

              // Step 2: advance UV from world velocity projected onto current
              // sample's tangent UNIT vectors, divided by tangent magnitudes.
              const safeTU = sample.tangentUNorm > 0 ? sample.tangentUNorm : 1;
              const safeTV = sample.tangentVNorm > 0 ? sample.tangentVNorm : 1;
              const vTanU_proj =
                vel.linear[0] * sample.tangentU[0] +
                vel.linear[1] * sample.tangentU[1] +
                vel.linear[2] * sample.tangentU[2];
              const vTanV_proj =
                vel.linear[0] * sample.tangentV[0] +
                vel.linear[1] * sample.tangentV[1] +
                vel.linear[2] * sample.tangentV[2];
              let u_raw = att.uv[0] + (vTanU_proj * dt) / safeTU;
              let v_raw = att.uv[1] + (vTanV_proj * dt) / safeTV;

              // Closed surfaces wrap. Folding here keeps the stored UV in [0, 1)
              // and prevents surfaceConstraintSystem from interpreting "ran around
              // the perimeter" as "walked off edge."
              if (surface.wrapsU()) u_raw = ((u_raw % 1) + 1) % 1;
              if (surface.wrapsV()) v_raw = ((v_raw % 1) + 1) % 1;

              // Step 3: sample new UV (clamped only on non-wrapping axes).
              let u_clamped = surface.wrapsU() ? u_raw : Math.max(0, Math.min(1, u_raw));
              let v_clamped = surface.wrapsV() ? v_raw : Math.max(0, Math.min(1, v_raw));
              let sample_new = surface.sampleAtUV(u_clamped, v_clamped);

              // Step 3b: corner-jump iterative analytical contact transfer.
              //
              // The UV-led integration above assumes the foot follows the
              // surface smoothly. That assumption fails when the surface
              // curvature exceeds the disc curvature (1/R) — at such
              // concave corners the foot's UV should JUMP from one
              // contact segment to another, while the disc center stays
              // at the multi-contact equilibrium (= R from both contacts).
              //
              // Algorithm (per user 2026-05-22):
              //   1. Slice the heightmap into a piecewise-linear profile
              //      in the velocity plane (= along the foot's horizontal
              //      motion direction × gravity-up).
              //   2. Sweep the disc circle from its start position toward
              //      the UV-led predicted end. For each non-skip segment,
              //      analytically find the smallest sweep parameter τ at
              //      which the disc first touches it (sweepCircleVsSegment).
              //   3. If a hit is found: foot jumps to the contact point on
              //      the new segment, velocity rotates onto the new tangent
              //      direction (× cornerTransferEfficiency, magnitude
              //      preserved). Continue iterating with the remaining
              //      time fraction.
              //   4. If no hit: smooth roll completes, UV-led prediction
              //      stands.
              //
              // Forward-compat for surface-to-surface transitions: today
              // the profile is built from this heightmap only. In a future
              // batch, the profile will be a UNION of segments from all
              // candidate surfaces in the velocity plane — the sweep math
              // is surface-agnostic, so the only change is the profile
              // construction (line marked below) and tracking which
              // surface contributed the hit segment so we can update
              // att.surfaceId alongside att.uv when transitioning. The
              // iteration loop itself is unchanged.
              if (surface instanceof HeightmapSurfaceProvider) {
                const footStartX = sample.position[0];
                const footStartY = sample.position[1];
                const footStartZ = sample.position[2];
                const footEndX = sample_new.position[0];
                const footEndZ = sample_new.position[2];
                const dfx = footEndX - footStartX;
                const dfz = footEndZ - footStartZ;
                const hLen = Math.hypot(dfx, dfz);

                dbg.hLen = hLen;
                if (hLen >= CORNER_JUMP_MIN_HORIZONTAL_FOOT_DELTA) {
                  const dhx = dfx / hLen;
                  const dhz = dfz / hLen;
                  dbg.dhX = dhx;
                  dbg.dhZ = dhz;
                  // Profile slice along the foot's motion direction.
                  // Half-back covers the disc radius behind; half-fwd
                  // covers the predicted motion plus margin so the sweep
                  // can reach segments ahead of the disc.
                  // ↓ FORWARD-COMPAT POINT: when surface-to-surface lands,
                  //   build a union of segments from all candidate surface
                  //   providers here, tagging each with its source surface
                  //   id for the post-hit transition handling.
                  const halfFwd = hLen + CORNER_JUMP_PROFILE_HALF_BACK;
                  // Cell-boundary-aware sampling: the profile must include
                  // every triangle boundary the profile line crosses, since
                  // those ARE the surface's piecewise-linear corners. Without
                  // sampling at the exact boundary positions, the corner-jump
                  // CCD misses the contact-transfer moment and the disc center
                  // jumps by R·|N_left − N_right| as the body's UV passes the
                  // boundary smoothly.
                  //
                  // For a triangulated heightmap surface the boundaries are:
                  //   1. Cell-edge crossings in X (= world X = vertex world X
                  //      for integer vertex i).
                  //   2. Cell-edge crossings in Z (= world Z = vertex world Z
                  //      for integer vertex j).
                  //   3. Diagonal crossings within each cell (= tx + tz = 1).
                  // All are linear-in-s equations for the profile line
                  // parameterized as (footStartX + s·dhX, footStartZ + s·dhZ).
                  const profileSStart = -CORNER_JUMP_PROFILE_HALF_BACK;
                  const profileSEnd = halfFwd;
                  const sValues: number[] = [profileSStart];
                  const W = surface.heightmap.width;
                  const H = surface.heightmap.height;
                  const ww = surface.worldWidth;
                  const wd = surface.worldDepth;
                  // 1. X boundaries: vertex world X positions.
                  if (Math.abs(dhx) > 1e-9) {
                    for (let vi = 0; vi < W; vi++) {
                      const vxWorld = vi * (ww / (W - 1)) - ww * 0.5;
                      const s = (vxWorld - footStartX) / dhx;
                      if (s > profileSStart && s < profileSEnd) sValues.push(s);
                    }
                  }
                  // 2. Z boundaries: vertex world Z positions.
                  if (Math.abs(dhz) > 1e-9) {
                    for (let vj = 0; vj < H; vj++) {
                      const vzWorld = vj * (wd / (H - 1)) - wd * 0.5;
                      const s = (vzWorld - footStartZ) / dhz;
                      if (s > profileSStart && s < profileSEnd) sValues.push(s);
                    }
                  }
                  // 3. Diagonal (tx + tz = 1) crossings within each cell the
                  // profile line passes through. Parameterize cell (vi, vj)
                  // with tx = ((footStartX + s·dhX) - vxLeft) / cellStepX,
                  // similarly tz. Diagonal: tx + tz = 1 → solve linear in s.
                  // Skip if denominator near-zero (profile parallel to diagonal).
                  const cellStepX = ww / (W - 1);
                  const cellStepZ = wd / (H - 1);
                  const dDiagDS = dhx / cellStepX + dhz / cellStepZ;
                  if (Math.abs(dDiagDS) > 1e-9) {
                    // Iterate cells the profile crosses. Find profile entry
                    // cell at sValues[0] (= profileSStart) and exit at
                    // profileSEnd. Step through each cell.
                    for (let vi = 0; vi < W - 1; vi++) {
                      for (let vj = 0; vj < H - 1; vj++) {
                        // Diagonal s for this cell:
                        //   tx + tz = 1
                        // (footStartX + s·dhX − vxLeft)/cellStepX
                        //   + (footStartZ + s·dhZ − vzBottom)/cellStepZ = 1
                        const vxLeft = vi * cellStepX - ww * 0.5;
                        const vzBottom = vj * cellStepZ - wd * 0.5;
                        const num = 1
                          - (footStartX - vxLeft) / cellStepX
                          - (footStartZ - vzBottom) / cellStepZ;
                        const s = num / dDiagDS;
                        if (s <= profileSStart || s >= profileSEnd) continue;
                        // Verify the crossing is INSIDE this cell, not just on its
                        // extended diagonal line.
                        const wx = footStartX + s * dhx;
                        const wz = footStartZ + s * dhz;
                        if (wx < vxLeft - 1e-9 || wx > vxLeft + cellStepX + 1e-9) continue;
                        if (wz < vzBottom - 1e-9 || wz > vzBottom + cellStepZ + 1e-9) continue;
                        sValues.push(s);
                      }
                    }
                  }
                  sValues.push(profileSEnd);
                  // Sort and de-duplicate (near-equal s values from boundary
                  // coincidence).
                  sValues.sort((a, b) => a - b);
                  const dedup: number[] = [sValues[0]];
                  for (let k = 1; k < sValues.length; k++) {
                    if (sValues[k] - dedup[dedup.length - 1] > 1e-6) dedup.push(sValues[k]);
                  }
                  // Sample heights at each kept s value.
                  const rawVerts: { s: number; y: number }[] = [];
                  for (const s of dedup) {
                    const wx = footStartX + s * dhx;
                    const wz = footStartZ + s * dhz;
                    const [uu, vv] = surface.worldToUV(wx, 0, wz);
                    const y = surface.uvToWorld(
                      Math.max(0, Math.min(1, uu)),
                      Math.max(0, Math.min(1, vv)),
                    )[1];
                    rawVerts.push({ s, y });
                  }
                  // Merge near-collinear adjacent segments. Without this,
                  // a piecewise-linear approximation of a smooth curve
                  // gets adjacent segments at angles < ~1°; each becomes
                  // a spurious "corner" the sweep would try to transition
                  // onto, drifting trajectories on what should be smooth
                  // roll. Threshold ≈ surface-tangent angle change per
                  // CORNER_JUMP_PROFILE_STEP that would correspond to a
                  // local curvature radius of R (= disc radius). Below
                  // this, the surface is "smooth enough" for the disc
                  // to roll without a contact transition.
                  const profileVerts: { s: number; y: number }[] = [];
                  if (rawVerts.length > 0) profileVerts.push(rawVerts[0]);
                  for (let i = 1; i < rawVerts.length - 1; i++) {
                    const prev = profileVerts[profileVerts.length - 1];
                    const cur = rawVerts[i];
                    const next = rawVerts[i + 1];
                    const d1s = cur.s - prev.s, d1y = cur.y - prev.y;
                    const d2s = next.s - cur.s, d2y = next.y - cur.y;
                    const cross = d1s * d2y - d1y * d2s;
                    const l1 = Math.hypot(d1s, d1y);
                    const l2 = Math.hypot(d2s, d2y);
                    // sin(angle change) = cross / (l1 * l2). Threshold
                    // = CORNER_JUMP_PROFILE_STEP / radius (= sin of the
                    // tangent-angle change at curvature 1/R over one
                    // profile step). Adjacent segments smoother than that
                    // merge into the previous segment.
                    const sinThreshold = CORNER_JUMP_PROFILE_STEP / radius;
                    if (Math.abs(cross) > sinThreshold * l1 * l2 || l1 < 1e-9 || l2 < 1e-9) {
                      profileVerts.push(cur);
                    }
                  }
                  if (rawVerts.length > 1) profileVerts.push(rawVerts[rawVerts.length - 1]);
                  dbg.profileVertCount = profileVerts.length;
                  // Max sin(angle) between adjacent kept segments.
                  let maxSin = 0;
                  for (let i = 1; i < profileVerts.length - 1; i++) {
                    const p = profileVerts[i - 1], c = profileVerts[i], n = profileVerts[i + 1];
                    const d1s = c.s - p.s, d1y = c.y - p.y;
                    const d2s = n.s - c.s, d2y = n.y - c.y;
                    const cross = d1s * d2y - d1y * d2s;
                    const l1 = Math.hypot(d1s, d1y), l2 = Math.hypot(d2s, d2y);
                    if (l1 > 1e-9 && l2 > 1e-9) {
                      const sinA = Math.abs(cross) / (l1 * l2);
                      if (sinA > maxSin) maxSin = sinA;
                    }
                  }
                  dbg.profileMaxSin = maxSin;

                  // Initial contact segment = profile segment containing s=0.
                  let skipSegIdx = -1;
                  for (let i = 0; i < profileVerts.length - 1; i++) {
                    if (profileVerts[i].s <= 0 && profileVerts[i + 1].s >= 0) {
                      skipSegIdx = i;
                      break;
                    }
                  }

                  // 2D state. Foot starts at (0, footStartY) in plane
                  // coords; disc center at (0 + R·n_skip.s, footStartY +
                  // R·n_skip.y) where n_skip is the initial segment's
                  // outward normal (perpendicular CCW of segment dir).
                  let nSkipS = 0, nSkipY = 1;
                  if (skipSegIdx >= 0) {
                    const segA = profileVerts[skipSegIdx];
                    const segB = profileVerts[skipSegIdx + 1];
                    const sDs = segB.s - segA.s;
                    const sDy = segB.y - segA.y;
                    const sLen = Math.hypot(sDs, sDy);
                    if (sLen > 1e-9) {
                      nSkipS = -sDy / sLen;
                      nSkipY = sDs / sLen;
                    }
                  }
                  let cs = 0 + radius * nSkipS;
                  let cy = footStartY + radius * nSkipY;
                  // 2D velocity from vel.linear projected onto the
                  // velocity plane. Decompose vel.linear into:
                  //   velS = in-plane horizontal (along d_h)
                  //   velY = in-plane vertical (along world up)
                  //   perp = out-of-plane horizontal (along d_h-perp in XZ)
                  //
                  // The 2D CCD iteration rotates (velS, velY) within the
                  // velocity plane. In 3D this rotation is around the
                  // axis perpendicular to the plane (= the perp direction
                  // in world XZ), so vectors along that axis — `perp` —
                  // are preserved. By carrying `perp` separately we
                  // reconstruct the full 3D velocity at the end and
                  // don't kill the body's perpendicular-to-plane momentum.
                  //
                  // We use vel.linear (not foot delta) so that high-
                  // curvature regions where the UV-led foot delta over-
                  // shoots vel·dt don't amplify the CCD's input velocity.
                  let velS = vel.linear[0] * dhx + vel.linear[2] * dhz;
                  let velY = vel.linear[1];
                  const perp = vel.linear[0] * (-dhz) + vel.linear[2] * dhx;
                  let remainingFrac = 1.0;
                  let cornerJumped = false;
                  // Reuse the outer-scoped contactTransferred — set true
                  // if the disc transfers to a NEW contact segment this
                  // tick. Smooth roll along the current skip segment sets
                  // `cornerJumped` (so the body uses CCD-tracked position)
                  // but does NOT set contactTransferred (because contact
                  // location moves continuously — no offset reset needed).
                  // Set of segments the disc has been in contact with this
                  // tick. Once transferred away from a segment, the disc
                  // can't re-transfer to it in the same tick — that would
                  // ping-pong on multi-contact configurations (= τ=0 hits
                  // bouncing between two simultaneously-tangent segments).
                  const visited = new Set<number>();
                  if (skipSegIdx >= 0) visited.add(skipSegIdx);

                  let iter = 0;
                  for (; iter < CORNER_JUMP_MAX_ITERATIONS; iter++) {
                    // Project velocity onto the current skip segment direction
                    // before sweeping — this is the rolling-without-slipping
                    // constraint: the disc center moves along the R-offset
                    // line of its contact segment, not along arbitrary world
                    // velocity. Magnitude is preserved (the segment absorbs
                    // the normal component as constraint reaction; tangent
                    // magnitude conserved per `cornerTransferEfficiency=1.0`).
                    // Without this projection, gravity's Y component during
                    // step 1 drifts the disc center off the segment's
                    // R-offset, producing spurious "leaving tangent" hits
                    // on subsequent iterations and the climb-steep-wall
                    // bouncing artifact we saw with triangulated normals.
                    if (skipSegIdx >= 0) {
                      const segA = profileVerts[skipSegIdx];
                      const segB = profileVerts[skipSegIdx + 1];
                      const segDxRaw = segB.s - segA.s;
                      const segDyRaw = segB.y - segA.y;
                      const segLen = Math.hypot(segDxRaw, segDyRaw);
                      if (segLen > 1e-9) {
                        const segDx = segDxRaw / segLen;
                        const segDy = segDyRaw / segLen;
                        const proj = velS * segDx + velY * segDy;
                        const sign = proj >= 0 ? 1 : -1;
                        const mag = Math.hypot(velS, velY);
                        velS = sign * mag * segDx;
                        velY = sign * mag * segDy;
                      }
                    }

                    const sweepDx = velS * remainingFrac * dt;
                    const sweepDy = velY * remainingFrac * dt;
                    const sweepLen = Math.hypot(sweepDx, sweepDy);
                    if (sweepLen < TAU_MIN) break;

                    // Find the smallest τ across all non-visited segments.
                    let bestTau = Infinity;
                    let bestSegIdx = -1;
                    for (let i = 0; i < profileVerts.length - 1; i++) {
                      if (visited.has(i)) continue;
                      const A = profileVerts[i];
                      const B = profileVerts[i + 1];
                      const tau = sweepCircleVsSegment(
                        cs, cy, sweepDx, sweepDy, radius,
                        A.s, A.y, B.s, B.y,
                      );
                      if (tau !== null && tau < bestTau) {
                        bestTau = tau;
                        bestSegIdx = i;
                      }
                    }
                    if (bestSegIdx < 0) {
                      // No contact transition during remaining sweep — disc
                      // smooth-rolls along the current skip segment. Advance
                      // disc center by the FULL remaining sweep displacement
                      // and finish.
                      cs += sweepDx;
                      cy += sweepDy;
                      cornerJumped = true; // ensure body uses CCD-tracked pos.
                      break;
                    }

                    // Advance disc center to the contact moment.
                    cs += bestTau * sweepDx;
                    cy += bestTau * sweepDy;

                    // Rotate velocity onto the hit segment's tangent
                    // direction, magnitude × efficiency.
                    const hSegA = profileVerts[bestSegIdx];
                    const hSegB = profileVerts[bestSegIdx + 1];
                    const tDs = hSegB.s - hSegA.s;
                    const tDy = hSegB.y - hSegA.y;
                    const tLen = Math.hypot(tDs, tDy);
                    if (tLen > 1e-9) {
                      const tdxn = tDs / tLen;
                      const tdyn = tDy / tLen;
                      const proj = velS * tdxn + velY * tdyn;
                      const sign = proj >= 0 ? 1 : -1;
                      const mag = Math.hypot(velS, velY) * profile.cornerTransferEfficiency;
                      velS = sign * mag * tdxn;
                      velY = sign * mag * tdyn;
                    }

                    remainingFrac *= 1 - Math.max(0, bestTau);
                    skipSegIdx = bestSegIdx;
                    visited.add(bestSegIdx);
                    cornerJumped = true;
                    contactTransferred = true;
                  }

                  if (iter >= CORNER_JUMP_MAX_ITERATIONS) {
                    att.cornerJumpIterationCapHits = (att.cornerJumpIterationCapHits ?? 0) + 1;
                    warnDev(
                      `surfaceConstrainedVelocity: corner-jump iteration cap (${CORNER_JUMP_MAX_ITERATIONS}) reached for entity ${id} at tick t=? — disc swept many segments in one tick. Investigate trajectory; record into baseline if legitimate.`,
                    );
                  }

                  if (cornerJumped) {
                    // Final foot in 2D = disc center − R · n_finalSeg.
                    let nFinS = 0, nFinY = 1;
                    if (skipSegIdx >= 0) {
                      const segA = profileVerts[skipSegIdx];
                      const segB = profileVerts[skipSegIdx + 1];
                      const sDs = segB.s - segA.s;
                      const sDy = segB.y - segA.y;
                      const sLen = Math.hypot(sDs, sDy);
                      if (sLen > 1e-9) {
                        nFinS = -sDy / sLen;
                        nFinY = sDs / sLen;
                      }
                    }
                    const footFinalS = cs - radius * nFinS;
                    const footFinalY = cy - radius * nFinY;
                    // Map foot back to world XYZ → UV. (For multi-surface,
                    // also need to update att.surfaceId here based on which
                    // surface the hit segment came from.)
                    const footWorldX = footStartX + footFinalS * dhx;
                    const footWorldZ = footStartZ + footFinalS * dhz;
                    const [uNew, vNew] = surface.worldToUV(footWorldX, footFinalY, footWorldZ);
                    u_raw = uNew;
                    v_raw = vNew;
                    if (surface.wrapsU()) u_raw = ((u_raw % 1) + 1) % 1;
                    if (surface.wrapsV()) v_raw = ((v_raw % 1) + 1) % 1;
                    u_clamped = surface.wrapsU() ? u_raw : Math.max(0, Math.min(1, u_raw));
                    v_clamped = surface.wrapsV() ? v_raw : Math.max(0, Math.min(1, v_raw));
                    sample_new = surface.sampleAtUV(u_clamped, v_clamped);
                    // Convert 2D velocity back to world XYZ, preserving
                    // the perp component. The 2D rotation kept velS² +
                    // velY² constant; perp was untouched. Total
                    // magnitude is conserved end-to-end:
                    //   |vel_new|² = velS² + velY² + perp² = |vel_pre|²
                    vel.linear[0] = velS * dhx + perp * (-dhz);
                    vel.linear[1] = velY;
                    vel.linear[2] = velS * dhz + perp * dhx;
                  }
                  dbg.cornerJumped = cornerJumped;
                  dbg.cornerJumpIters = iter;
                }
              }
              dbg.velAfterCornerJumpX = vel.linear[0];
              dbg.velAfterCornerJumpY = vel.linear[1];
              dbg.velAfterCornerJumpZ = vel.linear[2];

              // Step 4: body = contact + contactOffset (biped model, user
              // 2026-05-23). The contact-offset buffer decouples body
              // position from the surface-normal swing at triangle
              // boundaries, which was the root cause of the off-angle
              // teleport bug. Two mechanisms keep this physically
              // reasonable:
              //   (a) If the CCD transferred contact this tick (= disc
              //       rolled off one segment onto another), reset offset
              //       to (bodyPre − newContact) so body position is
              //       continuous across the otherwise-discontinuous
              //       contact jump.
              //   (b) Each tick, interpolate the offset toward the
              //       "desired" lean = R · normalize(blend(surface_normal,
              //       gravity_up, speed/maxSpeed)). At rest, gravity
              //       dominates (weight stacked above feet); at full
              //       speed, surface normal dominates (lean into surface).
              //
              // Future: replace the heuristic blend with a proper
              // biomechanical offset = f(foot_accel, external_force,
              // angular_momentum). For now this captures the right
              // qualitative behavior and unblocks off-angle motion.
              if (contactTransferred) {
                att.contactOffset[0] = bodyPreX - sample_new.position[0];
                att.contactOffset[1] = bodyPreY - sample_new.position[1];
                att.contactOffset[2] = bodyPreZ - sample_new.position[2];
              }
              // Desired offset direction = blend(N, gravity_up).
              const speed = Math.hypot(vel.linear[0], vel.linear[1], vel.linear[2]);
              const vMaxRun = profile.desiredRunSpeed > 0 ? profile.desiredRunSpeed : 1;
              const speedRatio = Math.min(1, speed / vMaxRun);
              const ga = a?.accel ?? [0, -9.81, 0];
              // NB: `a` was zeroed by the accumulator-clear at the bottom
              // of this system on previous tick? No — accumulator is
              // populated by ForceField BEFORE this system runs, so `a`
              // here is the current tick's gravity contribution + any
              // other external accel applied this tick.
              const gMag = Math.hypot(ga[0], ga[1], ga[2]);
              const gUpX = gMag > 1e-6 ? -ga[0] / gMag : 0;
              const gUpY = gMag > 1e-6 ? -ga[1] / gMag : 1;
              const gUpZ = gMag > 1e-6 ? -ga[2] / gMag : 0;
              let ddX = speedRatio * sample_new.normal[0] + (1 - speedRatio) * gUpX;
              let ddY = speedRatio * sample_new.normal[1] + (1 - speedRatio) * gUpY;
              let ddZ = speedRatio * sample_new.normal[2] + (1 - speedRatio) * gUpZ;
              // Project the blended direction onto the camera-up plane =
              // spanned by camera-forward and camera-up. Body leans only
              // in the screen-vertical direction — never sideways relative
              // to camera. Per user 2026-05-23: body should stay visually
              // "up" even when sliding sideways. Removing the camera-right
              // component from the desired direction achieves this.
              //
              // camera-right = F × upHint (= camera's world X axis).
              const input = ci.byEntity.get(id);
              if (input) {
                const Fcam0 = input.cameraLookDir[0];
                const Fcam1 = input.cameraLookDir[1];
                const Fcam2 = input.cameraLookDir[2];
                const Ucam0 = input.cameraUp[0];
                const Ucam1 = input.cameraUp[1];
                const Ucam2 = input.cameraUp[2];
                let camRX = Fcam1 * Ucam2 - Fcam2 * Ucam1;
                let camRY = Fcam2 * Ucam0 - Fcam0 * Ucam2;
                let camRZ = Fcam0 * Ucam1 - Fcam1 * Ucam0;
                const camRLen = Math.hypot(camRX, camRY, camRZ);
                if (camRLen > 1e-6) {
                  camRX /= camRLen; camRY /= camRLen; camRZ /= camRLen;
                  const ddR = ddX * camRX + ddY * camRY + ddZ * camRZ;
                  ddX -= ddR * camRX;
                  ddY -= ddR * camRY;
                  ddZ -= ddR * camRZ;
                }
              }
              const ddLen = Math.hypot(ddX, ddY, ddZ);
              const desX = ddLen > 1e-6 ? radius * ddX / ddLen : 0;
              const desY = ddLen > 1e-6 ? radius * ddY / ddLen : radius;
              const desZ = ddLen > 1e-6 ? radius * ddZ / ddLen : 0;
              // Exponential smoothing with τ = 0.2 s (= half-decay ~0.14 s).
              const offsetRecoverAlpha = 1 - Math.exp(-dt / 0.2);
              att.contactOffset[0] = att.contactOffset[0] * (1 - offsetRecoverAlpha) + desX * offsetRecoverAlpha;
              att.contactOffset[1] = att.contactOffset[1] * (1 - offsetRecoverAlpha) + desY * offsetRecoverAlpha;
              att.contactOffset[2] = att.contactOffset[2] * (1 - offsetRecoverAlpha) + desZ * offsetRecoverAlpha;
              t.position[0] = sample_new.position[0] + att.contactOffset[0];
              t.position[1] = sample_new.position[1] + att.contactOffset[1];
              t.position[2] = sample_new.position[2] + att.contactOffset[2];
              transforms.byEntity.set(id, t);

              // Step 5: drop the velocity component along sample_new.normal
              // (surface absorbs it as a constraint reaction).
              const vNnew =
                vel.linear[0] * sample_new.normal[0] +
                vel.linear[1] * sample_new.normal[1] +
                vel.linear[2] * sample_new.normal[2];
              vel.linear[0] -= vNnew * sample_new.normal[0];
              vel.linear[1] -= vNnew * sample_new.normal[1];
              vel.linear[2] -= vNnew * sample_new.normal[2];
              vels.byEntity.set(id, vel);

              // Store un-clamped UV so surfaceConstraint can detect "walked off edge";
              // cache the new sample on the attachment.
              att.uv = [u_raw, v_raw];
              att.sample = sample_new;
              atts.byEntity.set(id, att);

              // Debug capture (after every step has run). Cost when
              // disabled is one bool check.
              if (dbgEnabled) {
                writeBuffer(dbgBuf, (d) => {
                  let entry = d.byEntity.get(id);
                  if (!entry) { entry = { history: [] }; d.byEntity.set(id, entry); }
                  entry.history.push({
                    tick: entry.history.length,
                    nPreX: dbg.nPreX, nPreY: dbg.nPreY, nPreZ: dbg.nPreZ,
                    nPostX: sample_new.normal[0], nPostY: sample_new.normal[1], nPostZ: sample_new.normal[2],
                    velStartX: dbg.velStartX, velStartY: dbg.velStartY, velStartZ: dbg.velStartZ,
                    velAfterAccelX: dbg.velAfterAccelX, velAfterAccelY: dbg.velAfterAccelY, velAfterAccelZ: dbg.velAfterAccelZ,
                    velAfterCornerJumpX: dbg.velAfterCornerJumpX, velAfterCornerJumpY: dbg.velAfterCornerJumpY, velAfterCornerJumpZ: dbg.velAfterCornerJumpZ,
                    velFinalX: vel.linear[0], velFinalY: vel.linear[1], velFinalZ: vel.linear[2],
                    posX: t.position[0], posY: t.position[1], posZ: t.position[2],
                    dhX: dbg.dhX, dhZ: dbg.dhZ, hLen: dbg.hLen,
                    cornerJumped: dbg.cornerJumped, cornerJumpIters: dbg.cornerJumpIters,
                    profileVertCount: dbg.profileVertCount, profileMaxSin: dbg.profileMaxSin,
                    dropMagnitude: Math.abs(vNnew),
                  });
                });
              }
            }
          });
        });
      });

      // Clear accumulator slots we touched. Volumetric integrator clears its own.
      writeBuffer(fa, (d) => {
        for (const [id, ctrl] of cc.byEntity) {
          if (ctrl.locomotionMode !== "surfaceConstrained") continue;
          const aa = d.byEntity.get(id);
          if (aa) { aa.accel[0] = 0; aa.accel[1] = 0; aa.accel[2] = 0; }
        }
      });
    },
  };
}
