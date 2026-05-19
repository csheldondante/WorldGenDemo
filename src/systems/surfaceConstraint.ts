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
                  // volumeConstrained: check for landing
                  const [u, vUV] = surface.worldToUV(t.position[0], t.position[1], t.position[2]);
                  if (u < 0 || u > 1 || vUV < 0 || vUV > 1) {
                    // out of bounds; eventually we'd respawn, V1 just lets
                    // them fall forever
                    continue;
                  }
                  const sample = surface.sampleAtUV(u, vUV);
                  const groundY = sample.position[1] + radius;
                  // Land ONLY when the body has actually reached (or penetrated) the
                  // surface — i.e., `y ≤ groundY` AND moving downward. The previous form
                  // allowed a `+landingSnapMeters` grace ABOVE groundY, which caused brief
                  // detach events (running off a smooth lip at speed, normal change at the
                  // lip pushes vN slightly positive → centripetal-leave fires for one tick)
                  // to immediately re-attach the very next tick, because the surface had
                  // only dropped a few centimeters by then. Strict comparison preserves
                  // detach events long enough for gravity to actually arc the body away.
                  // Real landings (falling from height) still trigger: the body crosses
                  // groundY on the way down and the snap pulls them up to groundY.
                  const descending = v.linear[1] <= 0;
                  if (descending && t.position[1] <= groundY) {
                    t.position[0] = sample.position[0];
                    t.position[1] = groundY;
                    t.position[2] = sample.position[2];
                    v.linear[1] = 0;
                    transforms.byEntity.set(id, t);
                    vels.byEntity.set(id, v);
                    ctrl.locomotionMode = "surfaceConstrained";
                    ctrl.jumpHolding = false;
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
