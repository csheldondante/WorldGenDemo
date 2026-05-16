import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../buffers/surfaceProvider";
import {
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../buffers/surfaceAttachment";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import { SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID } from "./surfaceConstrainedVelocity";
import { VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID } from "./volumetricConstrainedVelocity";
import { recordTransition } from "./characterController";

export const SURFACE_CONSTRAINT_SYSTEM_ID = "surfaceConstraintSystem";

/**
 * Surface-attach/detach event handler (B.3+).
 *
 * For SURFACE-CONSTRAINED entities: the integration is already done in UV by
 * `SurfaceConstrainedVelocitySystem`. This system only checks whether the integration
 * pushed the UV out of the surface patch — if so, transition to airborne with reason
 * "walked off edge". No position snap; the body's world position came from the UV.
 *
 * For VOLUME-CONSTRAINED entities (airborne / falling): check landing. When the body
 * crosses below `groundY` (sample.y + bodyRadius) while moving downward, snap to
 * groundY and re-attach. Strict comparison (no grace window) — see
 * `wiki/worldgen-demo-landing-snap-strict.md` for why.
 */
export function createSurfaceConstraintSystem(): SystemDescriptor {
  return {
    id: SURFACE_CONSTRAINT_SYSTEM_ID,
    description:
      "Surface-attach/detach event handler. For surface-attached entities: detects walked-off-edge from out-of-bounds UV written by SurfaceConstrainedVelocity, transitions to airborne. For airborne entities: detects landing (body crosses below groundY while descending), snaps to surface and re-attaches.",
    buffers: [
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID,
      VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID,
    ],
    execute: ({ buffer, now }) => {
      const sp = readBuffer(buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID));
      const profile = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      if (!sp.heightmap) return;
      const surface = sp.heightmap;

      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const saBuf = buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);

      writeBuffer(ccBuf, (cc) => {
        writeBuffer(saBuf, (sa) => {
          writeBuffer(tBuf, (transforms) => {
            writeBuffer(vBuf, (vels) => {
              for (const [id, ctrl] of cc.byEntity) {
                const t = transforms.byEntity.get(id);
                const v = vels.byEntity.get(id);
                if (!t || !v) continue;
                const prof = profile.byId.get(ctrl.profileId);
                const radius = prof?.bodyRadius ?? 0.5;

                if (ctrl.locomotionMode === "surfaceConstrained") {
                  // SurfaceConstrainedVelocity already integrated UV and placed the
                  // body at sample(new_uv) + radius·N. We just check whether the new UV
                  // is out of bounds — if so, the body walked off the patch's edge and
                  // should transition to airborne. On wrapped axes (cylinder perimeter,
                  // torus loops) the integrator folded the value, so we ignore that
                  // axis here.
                  const att = sa.byEntity.get(id);
                  if (!att) continue;
                  const u = att.uv[0];
                  const v = att.uv[1];
                  const uOut = !surface.wrapsU() && (u < 0 || u > 1);
                  const vOut = !surface.wrapsV() && (v < 0 || v > 1);
                  if (uOut || vOut) {
                    ctrl.locomotionMode = "volumeConstrained";
                    recordTransition(ctrl, "airborne", "walked off edge", now);
                    // Clamp the cached UV so future reads are well-defined. Sample
                    // was already at clamped UV by the integrator.
                    const uClamp = surface.wrapsU() ? u : Math.max(0, Math.min(1, u));
                    const vClamp = surface.wrapsV() ? v : Math.max(0, Math.min(1, v));
                    att.uv = [uClamp, vClamp];
                    sa.byEntity.set(id, att);
                    cc.byEntity.set(id, ctrl);
                    continue;
                  }
                  // Otherwise: still attached. The integrator already wrote position,
                  // velocity, and the sample. No work to do.
                } else {
                  // volumeConstrained: check for landing — surface-normal-aware so it
                  // works on horizontal-axis cylinders and any other non-Y-up surface.
                  // Conditions:
                  //   1. Body has approached the surface within its radius along +N:
                  //        dot(pos - sample.pos, N) <= radius
                  //   2. Velocity is into the surface:  dot(v, N) <= 0
                  //
                  // On the wrap axis we use the integrator's already-folded UV; otherwise
                  // worldToUV may fall outside [0, 1] for non-wrapping axes (cylinder
                  // ends, plane edges) — let the body fall.
                  const [uRaw, vRaw] = surface.worldToUV(t.position[0], t.position[1], t.position[2]);
                  const u = surface.wrapsU() ? ((uRaw % 1) + 1) % 1 : uRaw;
                  const vUV = surface.wrapsV() ? ((vRaw % 1) + 1) % 1 : vRaw;
                  const uOut = !surface.wrapsU() && (u < 0 || u > 1);
                  const vOut = !surface.wrapsV() && (vUV < 0 || vUV > 1);
                  if (uOut || vOut) {
                    // out of bounds; V1 just lets the body fall forever (respawn TODO).
                    continue;
                  }
                  const sample = surface.sampleAtUV(u, vUV);
                  const Nx = sample.normal[0];
                  const Ny = sample.normal[1];
                  const Nz = sample.normal[2];
                  const dx = t.position[0] - sample.position[0];
                  const dy = t.position[1] - sample.position[1];
                  const dz = t.position[2] - sample.position[2];
                  const distAlongN = dx * Nx + dy * Ny + dz * Nz;
                  const vAlongN = v.linear[0] * Nx + v.linear[1] * Ny + v.linear[2] * Nz;
                  if (distAlongN <= radius && vAlongN <= 0) {
                    // Snap body to sample + radius·N; zero the normal component of velocity
                    // (tangent velocity preserved → character keeps running on landing).
                    t.position[0] = sample.position[0] + Nx * radius;
                    t.position[1] = sample.position[1] + Ny * radius;
                    t.position[2] = sample.position[2] + Nz * radius;
                    v.linear[0] -= vAlongN * Nx;
                    v.linear[1] -= vAlongN * Ny;
                    v.linear[2] -= vAlongN * Nz;
                    transforms.byEntity.set(id, t);
                    vels.byEntity.set(id, v);
                    ctrl.locomotionMode = "surfaceConstrained";
                    recordTransition(ctrl, "surfaceRun", "landed", now);
                    const att = sa.byEntity.get(id);
                    if (att) {
                      att.uv = [u, vUV];
                      att.sample = sample;
                      sa.byEntity.set(id, att);
                    }
                    cc.byEntity.set(id, ctrl);
                  }
                }
              }
            });
          });
        });
      });
    },
  };
}
