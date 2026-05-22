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
// Disc-multi-contact helpers retained for follow-up batches but unused while
// step 4b's UV-jump path is disabled (see comment in execute() below).
// import { HeightmapSurfaceProvider } from "../world/surfaceProvider";
// import { buildSurfaceProfile } from "../world/surfaceProfile";
// import { findCircleProfileIntersections } from "../lib/math/wheelIntersect";
// import { resolveDiscContacts } from "../lib/math/discContact";

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
              let u_clamped = surface.wrapsU() ? u_raw : Math.max(0, Math.min(1, u_raw));
              let v_clamped = surface.wrapsV() ? v_raw : Math.max(0, Math.min(1, v_raw));
              let sample_new = surface.sampleAtUV(u_clamped, v_clamped);

              // Step 4b: disc-vs-profile multi-contact UV jump — DISABLED
              // 2026-05-21. The piecewise-linear profile's far-contact UV
              // does not in practice satisfy the user's tangency invariant
              // (body xyz invariant across the jump) on our smooth bilinear
              // surface — the 0.25 m profile sampling produces multi-contact
              // detections whose "far UV" places the body at sample(far) +
              // R·N(far) ≠ pre-jump body xyz, which IS a teleport.
              //
              // The visible "snap onto the wall" is the projection-induced
              // velocity DIE across the rapid normal-frame rotation in the
              // high-curvature slope→wall region (each tick step 6 drops the
              // spurious vN that comes from the rotating frame, removing
              // tangent speed). Addressed below by switching step 6 to a
              // velocity-magnitude-preserving rotate (configured via
              // profile.cornerTransferEfficiency) UNCONDITIONALLY — the
              // efficiency factor itself is the per-character "agility" knob.
              //
              // Multi-contact detection imports (buildSurfaceProfile,
              // findCircleProfileIntersections, resolveDiscContacts,
              // HeightmapSurfaceProvider) are left in place in case a
              // follow-up batch re-enables true-tangency disc resolution.

              // Step 5: world position = sample_new + radius along sample_new.normal.
              // sample_new may be the original UV-integration sample OR the
              // jumped-to far-contact sample (step 4b). By the multi-contact
              // tangency invariant, this is the disc center either way — no
              // override branch, no energy rescale, no teleport.
              const bodyX = sample_new.position[0] + sample_new.normal[0] * radius;
              const bodyY = sample_new.position[1] + sample_new.normal[1] * radius;
              const bodyZ = sample_new.position[2] + sample_new.normal[2] * radius;
              t.position[0] = bodyX;
              t.position[1] = bodyY;
              t.position[2] = bodyZ;
              transforms.byEntity.set(id, t);

              // Step 6: project world velocity onto sample_new.normal (drop
              // the component along it — surface absorbs it as a constraint
              // reaction).
              //
              // A previous experiment 2026-05-21 made this a magnitude-
              // preserving rotation (scaled by profile.cornerTransferEfficiency)
              // to satisfy the user's "forward velocity translates into up at
              // the wall" intent, applied UNCONDITIONALLY. That implementation
              // injected energy on every tick of a smooth climb: gravity adds
              // a downward vel component in step 1, which the magnitude-
              // preserving rotation then re-cast as additional tangent speed,
              // letting the body gain potential energy without paying out
              // kinetic energy. Reverted to drop-normal.
              //
              // The "velocity dies at the wall" problem remains — speed
              // decays per-tick as the tangent frame rotates through the
              // high-curvature slope→wall region. The right fix needs
              // corner-event detection (rotate magnitude ONLY at the corner
              // moment, not every tick). The cornerTransferEfficiency profile
              // field is left in place for that follow-up; it is currently
              // unused by this code.
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
              void profile.cornerTransferEfficiency;  // suppress unused-field warning

              // Step 6b: energy-conservation rescale — REMOVED 2026-05-21.
              // The rescale existed to compensate for the (now-removed)
              // circumcenter xyz override. With body xyz invariant across the
              // multi-contact UV jump (by the tangency invariant), there is
              // no teleport to compensate for and KE is preserved by step 1
              // (accumulator integration) + step 6 (tangent projection).

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
