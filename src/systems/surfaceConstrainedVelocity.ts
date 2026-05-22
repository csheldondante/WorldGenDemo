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
              const u_clamped = surface.wrapsU() ? u_raw : Math.max(0, Math.min(1, u_raw));
              const v_clamped = surface.wrapsV() ? v_raw : Math.max(0, Math.min(1, v_raw));
              const sample_new = surface.sampleAtUV(u_clamped, v_clamped);

              // Step 4: world position = sample_new + R · sample_new.normal.
              t.position[0] = sample_new.position[0] + sample_new.normal[0] * radius;
              t.position[1] = sample_new.position[1] + sample_new.normal[1] * radius;
              t.position[2] = sample_new.position[2] + sample_new.normal[2] * radius;
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
