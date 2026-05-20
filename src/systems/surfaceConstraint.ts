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
import {
  VOLUME_FIELD_BUFFER_ID,
  type VolumeFieldBufferData,
} from "../buffers/volumeField";
import { SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID } from "./surfaceConstrainedVelocity";
import { VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID } from "./volumetricConstrainedVelocity";
import { recordTransition } from "./characterController";
import { buildSurfaceProfile } from "../world/surfaceProfile";
import { findCircleProfileIntersections } from "../lib/math/wheelIntersect";
import { resolveDiscContacts } from "../lib/math/discContact";
import { pickGravity, sortVolumesByPriority } from "../lib/math/gravityVolume";

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
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
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
      const vf = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));
      const gravityVolumes = sortVolumesByPriority(vf.volumes);
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
                  // volumeConstrained: check for landing via disc-vs-surface
                  // collision in the body's velocity plane. Matches the disc-
                  // collider model used by surfaceConstrainedVelocitySystem.
                  //
                  // Build a profile around the body's CURRENT position (not at
                  // sample's heightmap point), find disc-vs-profile contacts,
                  // and land when both:
                  //   - The disc has ≥1 contact with the surface.
                  //   - The body's velocity has a component INTO the contact
                  //     normal (= still descending toward the surface), so we
                  //     don't trigger landing while the body is mid-jump rising
                  //     past a surface above it.
                  //
                  // On landing, body's new position = disc-resolution center
                  // (NOT the legacy `sample + R·N` snap, which teleported the
                  // body's Y to whatever the heightmap sample at body's XZ was
                  // — visible as a position snap on jump → climb transitions).
                  //
                  // UV is derived from the foot (= disc_center − R · contact_
                  // normal) via surface.worldToUV; same downstream convention
                  // as surfaceConstrainedVelocity step 7.
                  const [uPre, vPre] = surface.worldToUV(
                    t.position[0], t.position[1], t.position[2],
                  );
                  if (uPre < 0 || uPre > 1 || vPre < 0 || vPre > 1) {
                    // Out of bounds; let them fall forever (V1 behavior).
                    continue;
                  }
                  const gAtBody = pickGravity(gravityVolumes, vf.gravity, [
                    t.position[0], t.position[1], t.position[2],
                  ]);
                  const gMag = Math.hypot(gAtBody[0], gAtBody[1], gAtBody[2]);
                  // disc_up = -normalize(gravity). Sample.normal fallback at the
                  // body's projected XZ if gravity is zero (no field defined).
                  let Nupx: number;
                  let Nupy: number;
                  let Nupz: number;
                  if (gMag > 1e-9) {
                    Nupx = -gAtBody[0] / gMag;
                    Nupy = -gAtBody[1] / gMag;
                    Nupz = -gAtBody[2] / gMag;
                  } else {
                    const sampleForN = surface.sampleAtUV(uPre, vPre);
                    Nupx = sampleForN.normal[0];
                    Nupy = sampleForN.normal[1];
                    Nupz = sampleForN.normal[2];
                  }
                  // Horizontal direction = velocity projected onto the disc-
                  // up-perpendicular plane. For a vertically-falling body this
                  // degenerates; fall back to any non-degenerate direction
                  // (here: world-X projected onto the tangent plane), since the
                  // disc-resolution result is rotation-invariant about disc_up
                  // for a tangent contact.
                  let dirX = v.linear[0];
                  let dirY = v.linear[1];
                  let dirZ = v.linear[2];
                  let vDotUp = dirX * Nupx + dirY * Nupy + dirZ * Nupz;
                  dirX -= vDotUp * Nupx;
                  dirY -= vDotUp * Nupy;
                  dirZ -= vDotUp * Nupz;
                  let dirMag = Math.hypot(dirX, dirY, dirZ);
                  if (dirMag < 1e-4) {
                    dirX = 1; dirY = 0; dirZ = 0;
                    vDotUp = dirX * Nupx + dirY * Nupy + dirZ * Nupz;
                    dirX -= vDotUp * Nupx;
                    dirY -= vDotUp * Nupy;
                    dirZ -= vDotUp * Nupz;
                    dirMag = Math.hypot(dirX, dirY, dirZ);
                  }
                  if (dirMag < 1e-4) {
                    // Degenerate gravity-X alignment too; skip this tick.
                    continue;
                  }
                  dirX /= dirMag;
                  dirY /= dirMag;
                  dirZ /= dirMag;
                  const halfWidth = radius * 1.5;
                  const stepLen = 0.25;
                  const profileVerts = buildSurfaceProfile(
                    surface,
                    t.position[0], t.position[1], t.position[2],
                    dirX, dirY, dirZ,
                    Nupx, Nupy, Nupz,
                    halfWidth, stepLen,
                  );
                  const intersections = findCircleProfileIntersections(
                    0, 0, radius, profileVerts,
                  );
                  const res = resolveDiscContacts(intersections, profileVerts, radius);
                  if (res === null) {
                    // No contact — still airborne.
                    continue;
                  }
                  // Contact normal in world coords.
                  const cNx = res.normalS * dirX + res.normalY * Nupx;
                  const cNy = res.normalS * dirY + res.normalY * Nupy;
                  const cNz = res.normalS * dirZ + res.normalY * Nupz;
                  // Don't land if body is moving AWAY from the surface (vN > 0
                  // means velocity has component along outward normal). This
                  // replaces the legacy `descending && y ≤ groundY` check.
                  // Strict — only trigger landing when the body's heading toward
                  // the surface — so mid-jump rising past a ledge doesn't snap.
                  const vN = v.linear[0] * cNx + v.linear[1] * cNy + v.linear[2] * cNz;
                  if (vN > 0) {
                    continue;
                  }
                  // Land. Position = disc-resolution center.
                  const newX = t.position[0] + res.centerS * dirX + res.centerY * Nupx;
                  const newY = t.position[1] + res.centerS * dirY + res.centerY * Nupy;
                  const newZ = t.position[2] + res.centerS * dirZ + res.centerY * Nupz;
                  t.position[0] = newX;
                  t.position[1] = newY;
                  t.position[2] = newZ;
                  // Drop velocity along contact normal (surface absorbs it).
                  v.linear[0] -= vN * cNx;
                  v.linear[1] -= vN * cNy;
                  v.linear[2] -= vN * cNz;
                  transforms.byEntity.set(id, t);
                  vels.byEntity.set(id, v);
                  ctrl.locomotionMode = "surfaceConstrained";
                  ctrl.jumpHolding = false;
                  recordTransition(ctrl, "surfaceRun", "landed", now);
                  // Derive UV from foot.
                  const footX = newX - radius * cNx;
                  const footY = newY - radius * cNy;
                  const footZ = newZ - radius * cNz;
                  let [uLand, vLand] = surface.worldToUV(footX, footY, footZ);
                  if (surface.wrapsU()) uLand = ((uLand % 1) + 1) % 1;
                  if (surface.wrapsV()) vLand = ((vLand % 1) + 1) % 1;
                  const uLandClamped = surface.wrapsU() ? uLand : Math.max(0, Math.min(1, uLand));
                  const vLandClamped = surface.wrapsV() ? vLand : Math.max(0, Math.min(1, vLand));
                  const landSample = surface.sampleAtUV(uLandClamped, vLandClamped);
                  const att = sa.byEntity.get(id);
                  if (att) {
                    att.uv = [uLand, vLand];
                    att.sample = landSample;
                    sa.byEntity.set(id, att);
                  }
                  cc.byEntity.set(id, ctrl);
                }
              }
            });
          });
        });
      });
    },
  };
}
