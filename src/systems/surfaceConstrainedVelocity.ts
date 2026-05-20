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
import { buildSurfaceProfile } from "../world/surfaceProfile";
import { findCircleProfileIntersections } from "../lib/math/wheelIntersect";
import { resolveDiscContacts } from "../lib/math/discContact";

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
              const sample_new = surface.sampleAtUV(u_clamped, v_clamped);

              // Capture body's world position BEFORE step 5 rewrites it. Used by
              // step 6b for the energy-conservation rescale across the disc-
              // resolution position derivation: KE_post = KE_pre + F · Δr, where
              // Δr = body_after − body_before and F = accumulator.accel (treated
              // constant over the tick per user 2026-05-20).
              const bodyPreX = t.position[0];
              const bodyPreY = t.position[1];
              const bodyPreZ = t.position[2];

              // Step 5: derive the disc-body world position.
              //
              // The body is modeled as a 2D disc of radius R in its velocity
              // plane. The velocity plane is spanned by:
              //   - `dir` = velocity projected onto sample's tangent plane,
              //     normalized. This is the body's instantaneous direction of
              //     motion along the surface. Falls back to projected
              //     `desiredFacingTangent` when velocity is near zero.
              //   - `up`  = sample.normal at the post-integration UV. Purely
              //     geometric — no gravity-up assumption. For heightmaps this
              //     is the bilinear-gradient normal; for spheres / cylinders /
              //     toruses it's the radial outward direction. Works in any
              //     gravity field.
              //
              // `buildSurfaceProfile` samples the surface along the line
              // `body + s·dir`, projects each sample's offset onto `up`, and
              // returns (s, y) vertices. `findCircleProfileIntersections` finds
              // disc-vs-profile contacts; `resolveDiscContacts` resolves them:
              //   "tangent"            — single smooth contact, disc tangent
              //                          to surface.
              //   "corner"             — two contacts on different segments
              //                          (concave corner); disc tucks into the
              //                          circumcenter. This is the case the
              //                          legacy `sample + R·N` mis-handled at
              //                          heightmap cell boundaries.
              //   "fallback-parallel"  — two collinear segments, no real
              //                          corner; treated as single-tangent on
              //                          the forward contact.
              //   "pop-out"            — disc partially embedded in one
              //                          segment; pop out perpendicular.
              //
              // Convex corners are NOT handled here — the controller's
              // centripetal-detach rule already triggers airborne FSM
              // transitions for those, and surfaceConstraint re-lands when the
              // body re-contacts the next surface.
              const Nupx = sample_new.normal[0];
              const Nupy = sample_new.normal[1];
              const Nupz = sample_new.normal[2];
              // Predicted body via legacy offset, used as the profile's origin
              // (disc-center prediction). Disc-resolution refines this.
              const predX = sample_new.position[0] + Nupx * radius;
              const predY = sample_new.position[1] + Nupy * radius;
              const predZ = sample_new.position[2] + Nupz * radius;

              // Horizontal direction = velocity projected onto sample's tangent
              // plane, normalized. Tangent-plane projection makes this work for
              // radial-gravity surfaces (sphere/cylinder/torus) too — velocity
              // is already tangent there, projection is a no-op; on a tilted
              // heightmap slope, projection drops the velocity-into-surface
              // component before normalizing.
              let dirX = vel.linear[0];
              let dirY = vel.linear[1];
              let dirZ = vel.linear[2];
              let vDotN = dirX * Nupx + dirY * Nupy + dirZ * Nupz;
              dirX -= vDotN * Nupx;
              dirY -= vDotN * Nupy;
              dirZ -= vDotN * Nupz;
              let dirMag = Math.hypot(dirX, dirY, dirZ);
              if (dirMag < 1e-4) {
                // Near-rest fallback: use desiredFacingTangent (input intent),
                // also projected onto sample's tangent plane.
                dirX = ctrl.desiredFacingTangent[0];
                dirY = ctrl.desiredFacingTangent[1];
                dirZ = ctrl.desiredFacingTangent[2];
                vDotN = dirX * Nupx + dirY * Nupy + dirZ * Nupz;
                dirX -= vDotN * Nupx;
                dirY -= vDotN * Nupy;
                dirZ -= vDotN * Nupz;
                dirMag = Math.hypot(dirX, dirY, dirZ);
              }

              let bodyX: number;
              let bodyY: number;
              let bodyZ: number;
              let contactNx: number;
              let contactNy: number;
              let contactNz: number;
              let discKind: "tangent" | "corner" | "fallback-parallel" | "pop-out" | null = null;
              if (dirMag > 1e-4) {
                dirX /= dirMag;
                dirY /= dirMag;
                dirZ /= dirMag;
                // Profile half-window: 1.5·R covers the disc's contact span.
                // Step 0.25 m is smaller than typical heightmap cell width
                // (1 m) so cell-boundary corners are always resolved; for
                // parametric surfaces it's fine-grained enough that the
                // piecewise-linear approximation tracks the smooth profile.
                const halfWidth = radius * 1.5;
                const stepLen = 0.25;
                const profileVerts = buildSurfaceProfile(
                  surface,
                  predX, predY, predZ,
                  dirX, dirY, dirZ,
                  Nupx, Nupy, Nupz,
                  halfWidth, stepLen,
                );
                // Profile origin = predicted body position. Disc center
                // candidate sits at profile (0, 0). The surface samples
                // generally have y ≈ −R near s=0 (body is R "above" surface
                // along the up axis); the disc circle of radius R touches the
                // profile at that point.
                const intersections = findCircleProfileIntersections(
                  0, 0, radius, profileVerts,
                );
                const res = resolveDiscContacts(intersections, profileVerts, radius);
                if (res !== null) {
                  // Map (s, y) → world: world = body + s·dir + y·up.
                  bodyX = predX + res.centerS * dirX + res.centerY * Nupx;
                  bodyY = predY + res.centerS * dirY + res.centerY * Nupy;
                  bodyZ = predZ + res.centerS * dirZ + res.centerY * Nupz;
                  // Contact normal in 3D = normalS·dir + normalY·up.
                  contactNx = res.normalS * dirX + res.normalY * Nupx;
                  contactNy = res.normalS * dirY + res.normalY * Nupy;
                  contactNz = res.normalS * dirZ + res.normalY * Nupz;
                  discKind = res.kind;
                } else {
                  // No contacts — disc is above the surface (airborne).
                  // surfaceConstraintSystem detects this via UV out-of-bounds
                  // or the airborne FSM transition next tick. Use predicted
                  // body so we don't leave t.position garbage.
                  bodyX = predX;
                  bodyY = predY;
                  bodyZ = predZ;
                  contactNx = Nupx;
                  contactNy = Nupy;
                  contactNz = Nupz;
                }
              } else {
                // No defined horizontal direction (body at rest with no input).
                // Disc resolution requires a direction to build the velocity
                // plane; without one, the disc-tangent position degenerates to
                // sample + R·N. Use that.
                bodyX = predX;
                bodyY = predY;
                bodyZ = predZ;
                contactNx = Nupx;
                contactNy = Nupy;
                contactNz = Nupz;
              }
              t.position[0] = bodyX;
              t.position[1] = bodyY;
              t.position[2] = bodyZ;
              transforms.byEntity.set(id, t);

              // Step 6: project world velocity onto the contact normal (drop
              // the component along it — the surface absorbs it as a constraint
              // reaction). Contact normal is the disc-resolution normal: for
              // single-contact it's the surface segment's outward normal; for
              // corners it's the bisector of the two segment normals.
              const Nnx = contactNx;
              const Nny = contactNy;
              const Nnz = contactNz;
              const vNnew =
                vel.linear[0] * Nnx +
                vel.linear[1] * Nny +
                vel.linear[2] * Nnz;
              vel.linear[0] -= vNnew * Nnx;
              vel.linear[1] -= vNnew * Nny;
              vel.linear[2] -= vNnew * Nnz;

              // Step 6b: energy conservation across the disc-resolution body-
              // position derivation.
              //
              // The disc branch may place the body at a different world
              // position than a "naive" `sample + R·sample.normal` legacy
              // would. The difference (Δr_disc) represents an instantaneous
              // position correction that wasn't backed by the natural
              // integration's velocity-times-dt motion. Without compensation,
              // total mechanical energy drifts each tick.
              //
              // Force F is constant over the tick (per user 2026-05-20: any
              // constant external force adds PE the same way; this includes
              // gravity, gravity volumes, and any future constant volume
              // fields baked into the accumulator). Work-energy theorem:
              //   ΔKE = F · Δr_body
              //
              // So:  KE_post = KE_pre + accumulator.accel · (body_after - body_before)
              //
              // where KE_pre = 0.5·|vel.prevLinear|² (start-of-tick KE) and
              // ΔbodyPos = body_after − body_before (full Δr this tick, NOT
              // just the disc-induced correction — the natural Δr is implicit
              // in the disc-resolution's continuity with vel-integration).
              //
              // Rescale post-step-6 velocity (= tangent-projected) to produce
              // the target KE, preserving direction. If KE_post ≤ 0 the body
              // didn't have the kinetic budget for the displacement — stall:
              // zero velocity, let FSM transitions react next tick.
              //
              // Applied ONLY when the disc branch fired with a CORNER kind —
              // that's where the position is discontinuously moved to the
              // disc-circumcenter, breaking the natural integration's
              // displacement assumption. For tangent / fallback-parallel /
              // pop-out, the disc-derived position essentially coincides
              // with the legacy sample + R·N derivation, the natural
              // integration's energy bookkeeping is already correct, and
              // applying the rescale would introduce its own discretization
              // drift over time (compounds noticeably across long straight-
              // line scenarios).
              if (discKind === "corner" && a) {
                const kePre =
                  0.5 *
                  (vel.prevLinear[0] * vel.prevLinear[0] +
                   vel.prevLinear[1] * vel.prevLinear[1] +
                   vel.prevLinear[2] * vel.prevLinear[2]);
                const work =
                  a.accel[0] * (bodyX - bodyPreX) +
                  a.accel[1] * (bodyY - bodyPreY) +
                  a.accel[2] * (bodyZ - bodyPreZ);
                const kePost = kePre + work;
                if (kePost <= 0) {
                  // Stall — body's start-of-tick KE wasn't enough to make this
                  // disc-induced displacement. Zero velocity; FSM (slip /
                  // detach triggers) reacts next tick.
                  vel.linear[0] = 0;
                  vel.linear[1] = 0;
                  vel.linear[2] = 0;
                } else {
                  const vMag = Math.hypot(
                    vel.linear[0], vel.linear[1], vel.linear[2],
                  );
                  if (vMag > 1e-9) {
                    const targetMag = Math.sqrt(2 * kePost);
                    const scale = targetMag / vMag;
                    vel.linear[0] *= scale;
                    vel.linear[1] *= scale;
                    vel.linear[2] *= scale;
                  }
                  // If vMag ≈ 0, leave velocity at zero — direction undefined
                  // and no kinetic budget to redirect.
                }
              }

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
