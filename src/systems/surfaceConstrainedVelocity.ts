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
import { assertDev } from "../runtime/dev";
import { findCircleProfileIntersections } from "../lib/math/wheelIntersect";
import { buildSurfaceProfile } from "../world/surfaceProfile";

export const SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID = "surfaceConstrainedVelocitySystem";

/**
 * UV-space integration for surface-attached characters.
 *
 * Replaces the prior "XYZ semi-implicit Euler then snap back to surface" pattern with a
 * single UV-space integration step that keeps the body geometrically on the surface at
 * all times. The world position is DERIVED from the new UV each tick (sample + radius·N);
 * world velocity is RECONSTRUCTED from UV velocity using the new tangent frame.
 *
 * Per-tick math (per the surface-frame-physics-solver wiki article):
 *   1. Project current world velocity onto sample tangents → UV-parameter velocity
 *      (divide by tangent magnitudes |∂P/∂u|, |∂P/∂v|).
 *   2. Project accumulator accel onto the same tangents → UV-parameter acceleration.
 *   3. Semi-implicit Euler in UV: uvel += auv·dt; uv += uvel·dt.
 *   4. Sample the surface at the new UV: get new world position and new tangent frame.
 *   5. World position = newSample.position + radius·newSample.normal (body offset along
 *      the new surface normal — works for any surface orientation).
 *   6. World velocity reconstructed from UV velocity × new tangent magnitudes × new
 *      tangents. The body's vN is implicitly zero — the constraint is exact.
 *
 * The normal component of the accumulator (gravity-into-surface, etc.) is dropped during
 * the tangent projection in step 2 — that's the constraint at work. No surface-reaction
 * force needed: the body is rigidly on the surface, and the controller's leave rule
 * decides separately when to detach.
 *
 * If the integrated UV crosses [0, 1] (character walks off the edge), this system flags
 * the attachment with `outOfBounds = true` by leaving the UV un-clamped and writing the
 * sample at the clamped UV. `SurfaceConstraintSystem` detects this and transitions to
 * airborne.
 *
 * Compared to B.2: same buffer access except we add SurfaceProviderBuffer (read for
 * sampleAtUV) and SurfaceAttachmentBuffer (readwrite for the UV update).
 */
export function createSurfaceConstrainedVelocitySystem(): SystemDescriptor {
  return {
    id: SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID,
    description:
      "UV-space integration for surface-attached characters. Projects world velocity & accel onto the surface tangent frame, integrates in UV via semi-implicit Euler, derives new world position from the integrated UV (sample + radius·N), and reconstructs world velocity from the new tangent frame. Eliminates the XYZ-then-snap pattern and its bug class (mesa-snap, cliff-snap, cylinder-embed).",
    buffers: [
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "readwrite" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_CONTROLLER_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const sp = readBuffer(buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID));
      const surface = sp.heightmap;
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const saBuf = buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);
      const accels = readBuffer(fa);

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

              // Step 2: capture post-acceleration speed (energy anchor).
              const speedTarget = Math.hypot(vel.linear[0], vel.linear[1], vel.linear[2]);

              // Step 3: advance UV from the world velocity projected onto current
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

              // Step 4: sample new UV (clamped only on non-wrapping axes for the actual sample call).
              const u_clamped = surface.wrapsU() ? u_raw : Math.max(0, Math.min(1, u_raw));
              const v_clamped = surface.wrapsV() ? v_raw : Math.max(0, Math.min(1, v_raw));
              let sample_new = surface.sampleAtUV(u_clamped, v_clamped);

              // Step 4b: wheel-vs-surface concave-corner detection. Model the body
              // as a wheel (circle of radius R) in its velocity plane (the vertical
              // plane through the body containing the horizontal velocity direction).
              // The smooth-roll integrator above advances UV along the OLD surface
              // and derives a single tangent contact — it never notices that the
              // wheel may already intersect a NEW segment (concave corner ahead).
              // If we find ≥2 intersections of the wheel with the surface profile in
              // the velocity plane and they straddle a cell boundary (different
              // segment indices), discretely jump UV to the forward intersection —
              // the new contact point — so the next position derivation in step 5
              // uses the new segment's normal. Convex corners are already handled
              // by the existing single-contact rolling.
              // Velocity-plane direction: prefer body's current horizontal
              // velocity; if essentially at rest, fall back to the user's
              // desired-tangent direction (the input/intent). One of those is
              // always meaningful unless the body is at rest with no input —
              // in which case there is no momentum and no corner-step to do.
              let dirX = 0;
              let dirZ = 0;
              const vHx = vel.linear[0];
              const vHz = vel.linear[2];
              const horizSpeed = Math.hypot(vHx, vHz);
              if (horizSpeed > 1e-4) {
                dirX = vHx / horizSpeed;
                dirZ = vHz / horizSpeed;
              } else {
                const desX = ctrl.desiredFacingTangent[0];
                const desZ = ctrl.desiredFacingTangent[2];
                const desLen = Math.hypot(desX, desZ);
                if (desLen > 1e-4) {
                  dirX = desX / desLen;
                  dirZ = desZ / desLen;
                }
              }
              if (dirX * dirX + dirZ * dirZ > 0.5) {
                const predBodyX = sample_new.position[0] + sample_new.normal[0] * radius;
                const predBodyY = sample_new.position[1] + sample_new.normal[1] * radius;
                const predBodyZ = sample_new.position[2] + sample_new.normal[2] * radius;
                // Window covers ≥1 wheel diameter so corners 1 cell ahead/behind are visible.
                const halfWidth = radius * 1.5;
                const step = radius * 0.1;
                const profile = buildSurfaceProfile(
                  surface,
                  predBodyX,
                  predBodyZ,
                  dirX,
                  dirZ,
                  halfWidth,
                  step,
                );
                const intersections = findCircleProfileIntersections(
                  0,
                  predBodyY,
                  radius,
                  profile,
                );
                if (intersections.length >= 2) {
                  let minSeg = Infinity;
                  let maxSeg = -Infinity;
                  for (const isct of intersections) {
                    if (isct.segmentIndex < minSeg) minSeg = isct.segmentIndex;
                    if (isct.segmentIndex > maxSeg) maxSeg = isct.segmentIndex;
                  }
                  // Different segments → real corner, not chord through one segment.
                  if (maxSeg > minSeg) {
                    // Pick the intersection furthest forward in momentum direction.
                    let best = intersections[0];
                    for (const isct of intersections) {
                      if (isct.s > best.s) best = isct;
                    }
                    if (best.s > 0) {
                      const contactX = predBodyX + best.s * dirX;
                      const contactZ = predBodyZ + best.s * dirZ;
                      const [u_jump, v_jump] = surface.worldToUV(
                        contactX,
                        best.y,
                        contactZ,
                      );
                      const u_jc = surface.wrapsU()
                        ? ((u_jump % 1) + 1) % 1
                        : Math.max(0, Math.min(1, u_jump));
                      const v_jc = surface.wrapsV()
                        ? ((v_jump % 1) + 1) % 1
                        : Math.max(0, Math.min(1, v_jump));
                      sample_new = surface.sampleAtUV(u_jc, v_jc);
                      u_raw = u_jump;
                      v_raw = v_jump;

                      // Project the new sample's surface normal into the
                      // velocity plane (= the plane the wheel is rolling in,
                      // spanned by horizontal velocity dir + world-up). The
                      // velocity-plane normal is `cross((dirX, 0, dirZ),
                      // (0, 1, 0)) = (-dirZ, 0, dirX)`. Without this projection
                      // the body's center derives from `sample + R · N`, and
                      // on a wall whose outward normal isn't aligned with the
                      // velocity direction the perpendicular component of
                      // R · N teleports the body sideways out of the velocity
                      // plane — visible as the sphere drifting/twisting off
                      // the line it was running along.
                      //
                      // Geometrically: a wheel rolling in a vertical plane
                      // must keep its center in that plane. We discard the
                      // out-of-plane component of N before applying the
                      // radius offset; the in-plane component still points
                      // "up away from the surface" within the slice, which
                      // is what the wheel rolls against.
                      const velPlaneNx = -dirZ;
                      const velPlaneNz = dirX;
                      const nDotPlaneN =
                        sample_new.normal[0] * velPlaneNx +
                        sample_new.normal[2] * velPlaneNz;
                      let nProjX = sample_new.normal[0] - nDotPlaneN * velPlaneNx;
                      let nProjY = sample_new.normal[1];
                      let nProjZ = sample_new.normal[2] - nDotPlaneN * velPlaneNz;
                      const nProjLen = Math.hypot(nProjX, nProjY, nProjZ);
                      if (nProjLen > 1e-6) {
                        nProjX /= nProjLen;
                        nProjY /= nProjLen;
                        nProjZ /= nProjLen;
                        // Mutate sample_new.normal so steps 5 + 6 below
                        // (position derivation + velocity tangent projection)
                        // use the in-plane normal automatically. This keeps
                        // the change local — no extra "effective normal"
                        // variable threading through the rest of the loop.
                        sample_new.normal[0] = nProjX;
                        sample_new.normal[1] = nProjY;
                        sample_new.normal[2] = nProjZ;
                      }
                      // (If the surface normal was almost exactly perpendicular
                      // to the velocity plane the projection collapses to zero
                      // — degenerate case where the wheel can't actually be in
                      // contact with this surface while traveling in the velocity
                      // plane. Leave sample_new.normal untouched in that edge
                      // case; downstream logic handles the "no contact" state.)

                      // Energy-conserving velocity rotation across the UV
                      // jump. The wheel pivots around the corner: total
                      // mechanical energy is invariant, so any rise in PE
                      // must be paid for out of KE. If the body lacks enough
                      // KE to make the height gain, it stalls (post-KE
                      // clamped to 0).
                      //
                      // PE bookkeeping uses world-up gravity (Y axis) for
                      // now — generalizes to per-entity gravity direction
                      // later when we have non-Y gravity fields. The
                      // pre-position is `t.position[1]` (still last tick's
                      // value at this point; step 5 hasn't run yet). The
                      // post-position is what step 5 will write —
                      // `sample_new.position[1] + sample_new.normal[1] *
                      // radius` (sample_new.normal has already been
                      // projected into the velocity plane above).
                      //
                      // Use start-of-tick velocity (`prevLinear`) and
                      // start-of-tick position (`t.position` — step 5 hasn't
                      // run) as the consistent pre-state. Mixing post-step-1
                      // velocity (which has gravity's impulse baked in over
                      // this tick's dt) with the pre-step-5 position double-
                      // counts gravity's "future work": gravity gave us KE
                      // worth a fall that the body never took because the
                      // UV jump intervened. Using prevLinear keeps the
                      // energy ledger honest.
                      //
                      // Side effect: input thrust applied this tick (the
                      // accel from the accumulator integration in step 1)
                      // doesn't contribute to the corner's KE budget either.
                      // That's deliberate — on a tick where the wheel
                      // pivots, treating the thrust as "rolling input" would
                      // route it into the vertical climb, which is the kind
                      // of magic-energy injection we just removed.
                      const G = 9.81;
                      const preKE =
                        0.5 *
                        (vel.prevLinear[0] * vel.prevLinear[0] +
                          vel.prevLinear[1] * vel.prevLinear[1] +
                          vel.prevLinear[2] * vel.prevLinear[2]);
                      const preY = t.position[1];
                      const postY =
                        sample_new.position[1] + sample_new.normal[1] * radius;
                      const dPE = G * (postY - preY);
                      const targetKE = Math.max(0, preKE - dPE);
                      const targetSpeed = Math.sqrt(2 * targetKE);

                      // Project velocity onto the new (in-plane) tangent
                      // plane to get the direction for the rescale.
                      const Nnx = sample_new.normal[0];
                      const Nny = sample_new.normal[1];
                      const Nnz = sample_new.normal[2];
                      const vNcorner =
                        vel.linear[0] * Nnx +
                        vel.linear[1] * Nny +
                        vel.linear[2] * Nnz;
                      vel.linear[0] -= vNcorner * Nnx;
                      vel.linear[1] -= vNcorner * Nny;
                      vel.linear[2] -= vNcorner * Nnz;
                      const vMagTan = Math.hypot(
                        vel.linear[0],
                        vel.linear[1],
                        vel.linear[2],
                      );
                      if (targetSpeed < 1e-6) {
                        // Insufficient KE to reach the new height — body
                        // stalls at the corner. (Future: trigger a fall-
                        // back transition; for now zero velocity is the
                        // honest answer to "you can't make it.")
                        vel.linear[0] = 0;
                        vel.linear[1] = 0;
                        vel.linear[2] = 0;
                      } else if (vMagTan > 1e-6) {
                        const scale = targetSpeed / vMagTan;
                        vel.linear[0] *= scale;
                        vel.linear[1] *= scale;
                        vel.linear[2] *= scale;
                      } else {
                        // Velocity was almost entirely along the new normal
                        // — synthesize the forward tangent in the velocity
                        // plane (velPlaneNormal × N), align with momentum,
                        // and scale to targetSpeed.
                        const velPlaneNx = -dirZ;
                        const velPlaneNz = dirX;
                        let tx = 0 * Nnz - velPlaneNz * Nny;
                        let ty = velPlaneNz * Nnx - velPlaneNx * Nnz;
                        let tz = velPlaneNx * Nny - 0 * Nnx;
                        const tLen = Math.hypot(tx, ty, tz);
                        if (tLen > 1e-6) {
                          tx /= tLen; ty /= tLen; tz /= tLen;
                          if (tx * dirX + tz * dirZ < 0) {
                            tx = -tx; ty = -ty; tz = -tz;
                          }
                          vel.linear[0] = targetSpeed * tx;
                          vel.linear[1] = targetSpeed * ty;
                          vel.linear[2] = targetSpeed * tz;
                        }
                      }
                    }
                  }
                }
              }

              // Step 5: world position = new surface point + radius along new normal.
              t.position[0] = sample_new.position[0] + sample_new.normal[0] * radius;
              t.position[1] = sample_new.position[1] + sample_new.normal[1] * radius;
              t.position[2] = sample_new.position[2] + sample_new.normal[2] * radius;
              transforms.byEntity.set(id, t);

              // Step 6: project world velocity onto the new tangent plane (drop the
              // component along the new normal — the surface absorbs it as a constraint
              // reaction). This is independent of whether tangents are orthogonal.
              const Nnx = sample_new.normal[0];
              const Nny = sample_new.normal[1];
              const Nnz = sample_new.normal[2];
              const vNnew =
                vel.linear[0] * Nnx +
                vel.linear[1] * Nny +
                vel.linear[2] * Nnz;
              vel.linear[0] -= vNnew * Nnx;
              vel.linear[1] -= vNnew * Nny;
              vel.linear[2] -= vNnew * Nnz;

              // Step 7 (DISABLED — bug audit 2026-05-19): the previous rescale-to-
              // speedTarget step preserved the wrong invariant. `speedTarget` is
              // captured AFTER step 1's accumulator integration, which includes any
              // normal-direction accel that step 6 will then absorb into the
              // constraint. Rescaling tangent magnitude to recover that "lost" speed
              // converts absorbed-normal-kinetic into tangent kinetic energy — same
              // conceptual leak as the aSurfaceN-in-accumulator bug, smaller magnitude.
              // Test before/after: if removing this step (a) eliminates the residual
              // visible stutter on climb-tall-wall and (b) doesn't measurably slow the
              // body on smooth curved surfaces (camera-hill-crest, gym-cylinder), the
              // rescale is the wrong invariant and should be permanently removed or
              // reworked. See audit note in the conversation log.
              //
              // const speedProj = Math.hypot(vel.linear[0], vel.linear[1], vel.linear[2]);
              // if (speedProj > 1e-9) {
              //   const scale = speedTarget / speedProj;
              //   vel.linear[0] *= scale;
              //   vel.linear[1] *= scale;
              //   vel.linear[2] *= scale;
              // }
              void speedTarget;  // suppress unused-var warning while step 7 is disabled
              vels.byEntity.set(id, vel);

              // Store un-clamped UV so surfaceConstraint can detect "walked off edge";
              // cache the new sample on the attachment.
              att.uv = [u_raw, v_raw];
              att.sample = sample_new;
              atts.byEntity.set(id, att);
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
