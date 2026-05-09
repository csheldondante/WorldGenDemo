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
import { VELOCITY_INTEGRATION_SYSTEM_ID } from "./velocityIntegration";

export const SURFACE_CONSTRAINT_SYSTEM_ID = "surfaceConstraintSystem";

/**
 * After integration: project surface-attached entities back onto the surface
 * (snap y to height + bodyRadius) and refresh the cached SurfaceSample. For
 * volume-constrained entities, check landing — if the player has fallen
 * within `landingSnapMeters` of the surface and is moving downward, re-attach.
 */
export function createSurfaceConstraintSystem(): SystemDescriptor {
  return {
    id: SURFACE_CONSTRAINT_SYSTEM_ID,
    description:
      "Snaps surface-attached entities to the surface y. Detects landings: volume-constrained entities reattach when descending into the surface.",
    buffers: [
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, VELOCITY_INTEGRATION_SYSTEM_ID],
    execute: ({ buffer }) => {
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
                  // Snap to surface, refresh sample
                  const [u, vUV] = surface.worldToUV(t.position[0], t.position[2]);
                  const clampedU = Math.max(0, Math.min(1, u));
                  const clampedV = Math.max(0, Math.min(1, vUV));
                  // If we walked off the world edge, fall into volume mode
                  if (clampedU !== u || clampedV !== vUV) {
                    ctrl.locomotionMode = "volumeConstrained";
                    ctrl.state = "airborne";
                    ctrl.lastTransitionReason = "walked off edge";
                    ctrl.timeInState = 0;
                    cc.byEntity.set(id, ctrl);
                    continue;
                  }
                  const sample = surface.sampleAtUV(clampedU, clampedV);
                  t.position[0] = sample.position[0];
                  t.position[1] = sample.position[1] + radius;
                  t.position[2] = sample.position[2];
                  transforms.byEntity.set(id, t);
                  // Refresh the attachment with the new sample
                  const att = sa.byEntity.get(id);
                  if (att) {
                    att.uv = [clampedU, clampedV];
                    att.sample = sample;
                    sa.byEntity.set(id, att);
                  }
                } else {
                  // volumeConstrained: check for landing
                  const [u, vUV] = surface.worldToUV(t.position[0], t.position[2]);
                  if (u < 0 || u > 1 || vUV < 0 || vUV > 1) {
                    // out of bounds; eventually we'd respawn, V1 just lets
                    // them fall forever
                    continue;
                  }
                  const sample = surface.sampleAtUV(u, vUV);
                  const groundY = sample.position[1] + radius;
                  // Land if descending and within the snap window
                  const descending = v.linear[1] <= 0;
                  if (descending && t.position[1] <= groundY + (prof?.landingSnapMeters ?? 0.4)) {
                    t.position[0] = sample.position[0];
                    t.position[1] = groundY;
                    t.position[2] = sample.position[2];
                    v.linear[1] = 0;
                    transforms.byEntity.set(id, t);
                    vels.byEntity.set(id, v);
                    ctrl.locomotionMode = "surfaceConstrained";
                    ctrl.state = "surfaceRun";
                    ctrl.lastTransitionReason = "landed";
                    ctrl.timeInState = 0;
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
