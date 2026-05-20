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
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../buffers/volumeField";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { assertDev } from "../runtime/dev";
import { findCircleProfileIntersections } from "../lib/math/wheelIntersect";
import { buildSurfaceProfile } from "../world/surfaceProfile";
import { resolveDiscContacts } from "../lib/math/discContact";
import { pickGravity, sortVolumesByPriority } from "../lib/math/gravityVolume";
import { HeightmapSurfaceProvider } from "../world/surfaceProvider";

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
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
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
      const vol = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));
      const sortedVolumes = sortVolumesByPriority(vol.volumes);
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const saBuf = buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);
      const accels = readBuffer(fa);
      // REVIEW(disc-model): Gravity-only PE for energy conservation; generalize
      // to Σ F_external · Δpos when we add non-gravity force volumes.
      const G_MAG = 9.81;

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
              // (chain dynamics, hit reactions, future ragdoll triggers) AND
              // for energy bookkeeping (start-of-tick KE before this tick's
              // gravity impulse).
              vel.prevLinear[0] = vel.linear[0];
              vel.prevLinear[1] = vel.linear[1];
              vel.prevLinear[2] = vel.linear[2];

              // Branch on surface type. Disc-in-velocity-plane model needs
              // a heightmap (the surface profile is built by sweeping a
              // horizontal line and reading h(x,z) — only HeightmapSurfaceProvider
              // supports that). Other providers (cylinder, parametric) keep
              // the existing UV-integrate flow below.
              //
              // REVIEW(disc-model): If we add another surface type that supports
              // velocity-plane profile slicing, extend the type check here. For
              // now this branch is binary: heightmap → disc model, else legacy.
              if (surface instanceof HeightmapSurfaceProvider) {
                // ─────────────────────────────────────────────────────────
                // DISC-IN-VELOCITY-PLANE MODEL
                // ─────────────────────────────────────────────────────────
                // The body is a 2D disc of radius R rolling in its velocity
                // plane. We do not derive position from `sample + R · N`
                // anymore — instead we (1) integrate body position from
                // velocity, (2) build the surface profile in the velocity
                // plane, (3) find all disc-vs-profile contacts, (4) resolve
                // them via `resolveDiscContacts` to get the canonical disc
                // center (handles smooth-roll, concave corner, and embedded
                // chord cases), (5) conserve total mechanical energy across
                // the implicit pivot. Sphere offsets are GONE.

                // REVIEW(disc-model): Step 1 — apply force accumulator to
                // velocity. Same as the legacy path; gravity + thrust live
                // in `accel`.
                const aDisc = accels.byEntity.get(id);
                if (aDisc) {
                  vel.linear[0] += aDisc.accel[0] * dt;
                  vel.linear[1] += aDisc.accel[1] * dt;
                  vel.linear[2] += aDisc.accel[2] * dt;
                }

                // REVIEW(disc-model): Step 2 — establish the velocity plane.
                // gravity_up is the negated local gravity (= world-up under
                // Y-gravity; radial-out on cylinders). Velocity plane spans
                // (horizontal_velocity_dir, gravity_up). Profile gets built
                // along the horizontal velocity direction (which on Y-gravity
                // is the XZ component of velocity; on cylinders it's the
                // component perpendicular to local gravity). For the
                // HeightmapSurfaceProvider this branch services, gravity is
                // Y-aligned in all current scenes, so the horizontal
                // projection is just (vel.x, 0, vel.z).
                const gravity = pickGravity(sortedVolumes, vol.gravity, t.position);
                const gLen = Math.hypot(gravity[0], gravity[1], gravity[2]);
                const gUpX = gLen > 1e-6 ? -gravity[0] / gLen : 0;
                const gUpY = gLen > 1e-6 ? -gravity[1] / gLen : 1;
                const gUpZ = gLen > 1e-6 ? -gravity[2] / gLen : 0;

                // Horizontal velocity direction = velocity projected onto the
                // plane perpendicular to gravity_up, then normalized. On
                // Y-gravity scenes this just drops the Y component of vel.
                const velStartX = vel.prevLinear[0];
                const velStartY = vel.prevLinear[1];
                const velStartZ = vel.prevLinear[2];
                const velDotGUp =
                  velStartX * gUpX + velStartY * gUpY + velStartZ * gUpZ;
                let dirX = velStartX - velDotGUp * gUpX;
                let dirY = velStartY - velDotGUp * gUpY;
                let dirZ = velStartZ - velDotGUp * gUpZ;
                let dirLen = Math.hypot(dirX, dirY, dirZ);
                if (dirLen < 1e-4) {
                  // Fallback: use desiredFacingTangent's component perpendicular
                  // to gravity_up. Same fallback the legacy path used.
                  const desX = ctrl.desiredFacingTangent[0];
                  const desY = ctrl.desiredFacingTangent[1];
                  const desZ = ctrl.desiredFacingTangent[2];
                  const desDotGUp = desX * gUpX + desY * gUpY + desZ * gUpZ;
                  dirX = desX - desDotGUp * gUpX;
                  dirY = desY - desDotGUp * gUpY;
                  dirZ = desZ - desDotGUp * gUpZ;
                  dirLen = Math.hypot(dirX, dirY, dirZ);
                }
                // If we still have no defined plane direction (body at rest
                // with no input), skip the disc model this tick. Fall back
                // to the legacy UV-integrate flow below. This keeps standing-
                // still behavior identical to today.
                if (dirLen < 1e-4) {
                  // Note: surface is heightmap so we KNOW the legacy path
                  // below works; just don't `continue`.
                  // (Re-entering the legacy code path that follows the
                  //  closing brace of this branch.)
                  // REVIEW(disc-model): consider a no-op tick instead of
                  // falling back to UV-integrate — body's at rest, nothing
                  // needs integrating.
                } else {
                  dirX /= dirLen;
                  dirY /= dirLen;
                  dirZ /= dirLen;

                  // REVIEW(disc-model): Step 3 — integrate position from
                  // velocity (NOT UV from tangent-projected velocity). This
                  // is the structural change. `body_pred` is where the disc
                  // center would land under free integration; the contact
                  // resolution below adjusts it to enforce surface contact.
                  const bodyPredX = t.position[0] + vel.linear[0] * dt;
                  const bodyPredY = t.position[1] + vel.linear[1] * dt;
                  const bodyPredZ = t.position[2] + vel.linear[2] * dt;

                  // REVIEW(disc-model): Step 4 — build the surface profile in
                  // the velocity plane. `buildSurfaceProfile` slices the
                  // heightmap along a horizontal line; we use the XZ
                  // projection of dir (the profile builder doesn't accept a
                  // 3D direction). For Y-gravity scenes (only case this
                  // branch services today) dir IS purely horizontal so this
                  // is exact.
                  const horizDirLen = Math.hypot(dirX, dirZ);
                  const profDirX = horizDirLen > 1e-6 ? dirX / horizDirLen : 1;
                  const profDirZ = horizDirLen > 1e-6 ? dirZ / horizDirLen : 0;
                  const halfWidth = radius * 1.5;
                  const sampleStep = radius * 0.1;
                  const profileVerts = buildSurfaceProfile(
                    surface,
                    bodyPredX,
                    bodyPredZ,
                    profDirX,
                    profDirZ,
                    halfWidth,
                    sampleStep,
                  );

                  // REVIEW(disc-model): Step 5 — find ALL disc-circle vs
                  // profile intersections, then resolve into a single disc
                  // center via the helper. The wheel-center s-coordinate is
                  // 0 (profile is centered on bodyPred); the wheel-center
                  // y-coordinate is bodyPred.y.
                  const intersections = findCircleProfileIntersections(
                    0,
                    bodyPredY,
                    radius,
                    profileVerts,
                  );
                  const resolution = resolveDiscContacts(
                    intersections,
                    profileVerts,
                    radius,
                  );

                  if (!resolution) {
                    // REVIEW(disc-model): No contacts — body is airborne
                    // (ran off a cliff, jumped, etc.). Write the freely-
                    // integrated body position and flag att.uv with an
                    // out-of-bounds sentinel so `surfaceConstraint`'s
                    // "walked off edge" detect fires this tick. The
                    // sentinel value (−1, −1) is unambiguous: real UVs
                    // are always in `[0, 1]`, even on wrapping surfaces
                    // before the modulo fold.
                    t.position[0] = bodyPredX;
                    t.position[1] = bodyPredY;
                    t.position[2] = bodyPredZ;
                    transforms.byEntity.set(id, t);
                    vels.byEntity.set(id, vel);
                    att.uv = [-1, -1];
                    atts.byEntity.set(id, att);
                    continue;
                  }

                  // Translate disc-center (s, y) back to world XYZ. centerS is
                  // measured along the profile direction from bodyPred's XZ;
                  // centerY is world Y directly.
                  const newBodyX = bodyPredX + resolution.centerS * profDirX;
                  const newBodyY = resolution.centerY;
                  const newBodyZ = bodyPredZ + resolution.centerS * profDirZ;

                  // REVIEW(disc-model): Sanity guard for convex-corner / cliff-
                  // edge cases. When the body runs off a cliff, the disc may
                  // briefly find a contact on the cliff face (a near-vertical
                  // segment), which resolveDiscContacts treats as a tangent
                  // contact and snaps the body's center onto the face's
                  // outward-normal direction. The resolved position can be
                  // FAR from body_pred (full R behind, off to the side, etc.).
                  // That's a physically wrong "stick to the cliff" result — a
                  // real disc rolling off a cliff pivots at the edge vertex,
                  // not slides down the face. Detect: if the resolved center
                  // is unreasonably far from the freely-integrated body
                  // position (> 1.5 R), fall back to airborne. The body
                  // continues on its velocity-integrated trajectory; surface-
                  // Constraint detects the detach via att.uv = (-1, -1).
                  // Threshold 1.5 R chosen empirically — normal rolling and
                  // wall-climb resolutions stay well under R; only pathological
                  // snap-to-face cases exceed it.
                  const resolvedDelta = Math.hypot(
                    newBodyX - bodyPredX,
                    newBodyY - bodyPredY,
                    newBodyZ - bodyPredZ,
                  );
                  if (resolvedDelta > radius * 1.5) {
                    t.position[0] = bodyPredX;
                    t.position[1] = bodyPredY;
                    t.position[2] = bodyPredZ;
                    transforms.byEntity.set(id, t);
                    vels.byEntity.set(id, vel);
                    att.uv = [-1, -1];
                    atts.byEntity.set(id, att);
                    continue;
                  }

                  // Contact normal in world XYZ. The (normalS, normalY) lives
                  // in the (s, y) plane; lift normalS into 3D along profDir.
                  const contactNx = resolution.normalS * profDirX;
                  const contactNy = resolution.normalY;
                  const contactNz = resolution.normalS * profDirZ;
                  // Re-normalize (defensive; the resolver returns unit, but
                  // the lift can pick up FP drift).
                  const cnLen = Math.hypot(contactNx, contactNy, contactNz) || 1;
                  const cNx = contactNx / cnLen;
                  const cNy = contactNy / cnLen;
                  const cNz = contactNz / cnLen;

                  // REVIEW(disc-model): Step 6 — energy conservation
                  // (gravity-only this batch per plan). Pre-KE uses prevLinear
                  // (start-of-tick velocity) so the gravity impulse applied
                  // in step 1 doesn't double-count. ΔY is the change in body
                  // center height. If KE_target < 0 → body lacked the budget
                  // for the climb → clamp velocity to zero (body stalls).
                  const preKE =
                    0.5 *
                    (vel.prevLinear[0] * vel.prevLinear[0] +
                      vel.prevLinear[1] * vel.prevLinear[1] +
                      vel.prevLinear[2] * vel.prevLinear[2]);
                  const dY = newBodyY - t.position[1];
                  const targetKE = Math.max(0, preKE - G_MAG * dY);
                  const targetSpeed = Math.sqrt(2 * targetKE);

                  // Project velocity onto the contact tangent plane (drop
                  // normal-direction component the surface absorbs as
                  // constraint reaction). Then rescale to targetSpeed.
                  const vDotN =
                    vel.linear[0] * cNx + vel.linear[1] * cNy + vel.linear[2] * cNz;
                  vel.linear[0] -= vDotN * cNx;
                  vel.linear[1] -= vDotN * cNy;
                  vel.linear[2] -= vDotN * cNz;
                  const vMagTan = Math.hypot(
                    vel.linear[0],
                    vel.linear[1],
                    vel.linear[2],
                  );
                  if (targetSpeed < 1e-6) {
                    vel.linear[0] = 0;
                    vel.linear[1] = 0;
                    vel.linear[2] = 0;
                  } else if (vMagTan > 1e-6) {
                    const scale = targetSpeed / vMagTan;
                    vel.linear[0] *= scale;
                    vel.linear[1] *= scale;
                    vel.linear[2] *= scale;
                  }
                  // (vMagTan ≈ 0 with targetSpeed > 0 means the body's velocity
                  // was almost entirely along the contact normal — landing.
                  // The constraint absorbed it; body stalls until the next
                  // tick of input/gravity. No synthesis needed in this case
                  // because the body just came to rest on the surface.)

                  // Write new body center.
                  t.position[0] = newBodyX;
                  t.position[1] = newBodyY;
                  t.position[2] = newBodyZ;
                  transforms.byEntity.set(id, t);
                  vels.byEntity.set(id, vel);

                  // REVIEW(disc-model): Step 7 — derive new attachment UV
                  // from the foot position (body_center − R · contact_normal).
                  // The foot is on the surface; its UV is the canonical
                  // attachment for next tick's tangent frame. Out-of-bounds
                  // UVs propagate to `surfaceConstraint` which detects
                  // walked-off-edge → detach.
                  const footX = newBodyX - radius * cNx;
                  const footZ = newBodyZ - radius * cNz;
                  const [uNew, vNew] = surface.worldToUV(footX, 0, footZ);
                  att.uv = [uNew, vNew];
                  // Re-sample so next tick reads consistent tangent magnitudes.
                  const uClamp = surface.wrapsU()
                    ? ((uNew % 1) + 1) % 1
                    : Math.max(0, Math.min(1, uNew));
                  const vClamp = surface.wrapsV()
                    ? ((vNew % 1) + 1) % 1
                    : Math.max(0, Math.min(1, vNew));
                  att.sample = surface.sampleAtUV(uClamp, vClamp);
                  atts.byEntity.set(id, att);

                  // Clear this entity's accumulator slot (the legacy path
                  // does this in a separate pass at the bottom; replicate
                  // here because we `continue` past it).
                  continue;
                }
              }

              // ─────────────────────────────────────────────────────────────
              // LEGACY UV-INTEGRATE PATH — used by non-heightmap surfaces
              // (cylinder, future parametric providers). Behavior preserved
              // exactly so the cylinder gym tests stay green.
              // ─────────────────────────────────────────────────────────────

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

              // Legacy path: no corner-jump (heightmap-only logic moved into
              // the disc model up top). Step 5 follows directly.
              void u_raw; void v_raw; // tracked through att.uv below; suppress unused-let warnings if applicable

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
