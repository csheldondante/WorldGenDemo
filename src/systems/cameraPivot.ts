import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../buffers/volumeField";
import { pickGravity, sortVolumesByPriority } from "../lib/math/gravityVolume";
import { dot, normalize } from "../lib/math/vec3";
import type { Vec3 } from "../lib/math/quat";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";

export const CAMERA_PIVOT_SYSTEM_ID = "cameraPivotSystem";

/**
 * Writes `cameraBuffer.pivot` — the orbit centre + a local frame the orbit
 * system rotates around.
 *
 * - `pivot.position`: smoothed chase of the followed character (exponential,
 *   `1 − exp(−dt · pivotResponsiveness)`).
 * - `pivot.up`: smoothed chase of `−normalize(gravity(at character))`. Picks
 *   up radial-gravity volumes automatically; cylinder/sphere worlds get a
 *   correctly-oriented camera without any per-scene wiring.
 * - `pivot.fwd`: parallel-transported each tick. The previous tick's `fwd`
 *   is projected onto the plane perpendicular to the new `up` and
 *   renormalized; this is the standard fix that keeps the camera's "behind"
 *   direction continuous as `up` rotates over hills / around cylinders.
 *
 * Singularity guard: if the projection of old `fwd` onto the new tangent
 * plane has near-zero length (i.e. the up axis has flipped ~180° in one
 * tick), the transport falls back to a basis-vector method to avoid
 * NaN/jitter.
 */
function exponentialAlpha(dt: number, rate: number): number {
  return 1 - Math.exp(-Math.max(0, dt) * Math.max(0, rate));
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Parallel-transport `prevFwd` onto the plane perpendicular to `newUp`.
 * Returns a unit vector ⊥ newUp that is the projection of prevFwd onto that
 * plane (renormalized). If the projection is degenerate (|projection| < 1e-6),
 * falls back to a stable basis vector perpendicular to newUp so we never
 * hand back NaN.
 */
function parallelTransport(prevFwd: Vec3, newUp: Vec3): Vec3 {
  const d = dot(prevFwd, newUp);
  const px = prevFwd[0] - d * newUp[0];
  const py = prevFwd[1] - d * newUp[1];
  const pz = prevFwd[2] - d * newUp[2];
  const len = Math.hypot(px, py, pz);
  if (len > 1e-6) {
    return [px / len, py / len, pz / len];
  }
  // Degenerate: prevFwd is parallel to newUp. Pick the world axis least
  // aligned with newUp, then project. This only fires near up-flip events.
  const ax = Math.abs(newUp[0]);
  const ay = Math.abs(newUp[1]);
  const az = Math.abs(newUp[2]);
  let ref: Vec3;
  if (ax <= ay && ax <= az) ref = [1, 0, 0];
  else if (ay <= az) ref = [0, 1, 0];
  else ref = [0, 0, 1];
  const d2 = dot(ref, newUp);
  return normalize([ref[0] - d2 * newUp[0], ref[1] - d2 * newUp[1], ref[2] - d2 * newUp[2]]);
}

export function createCameraPivotSystem(): SystemDescriptor {
  return {
    id: CAMERA_PIVOT_SYSTEM_ID,
    description:
      "Writes CameraBuffer.pivot — orbit centre + local frame. Samples local gravity via volumeField for pivot.up, parallel-transports pivot.fwd each tick, and exponentially chases position/up/fwd toward their targets at pivotResponsiveness.",
    buffers: [
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID, FORCE_FIELD_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const vol = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));
      const camBuf = buffer<CameraBufferData>(CAMERA_BUFFER_ID);

      const targetId = cc.byEntity.keys().next().value as number | undefined;
      if (targetId === undefined) return;
      const t = transforms.byEntity.get(targetId);
      if (!t) return;

      const c0 = readBuffer(camBuf);
      const charPos: Vec3 = [t.position[0], t.position[1], t.position[2]];
      const sortedVolumes = sortVolumesByPriority(vol.volumes);
      const gravity = pickGravity(sortedVolumes, vol.gravity, charPos);
      const gLen = Math.hypot(gravity[0], gravity[1], gravity[2]);
      // Zero-gravity guard: keep the previous up direction; nothing reasonable to derive from a null gravity vector.
      const desiredUp: Vec3 = gLen > 1e-6
        ? [-gravity[0] / gLen, -gravity[1] / gLen, -gravity[2] / gLen]
        : [c0.pivot.up[0], c0.pivot.up[1], c0.pivot.up[2]];

      const alpha = exponentialAlpha(dt, c0.params.pivotResponsiveness);

      // Smooth pivot.position toward the character.
      const newPos = lerpVec3(c0.pivot.position, charPos, alpha);
      // Smooth pivot.up toward desiredUp, then renormalize (lerp of unit vectors isn't unit).
      const smoothedUp = lerpVec3(c0.pivot.up, desiredUp, alpha);
      const newUp = normalize(smoothedUp);

      // Parallel-transport fwd onto the plane ⊥ newUp.
      const transportedFwd = parallelTransport(c0.pivot.fwd, newUp);
      // Then exponential chase from the previous fwd toward the transported one
      // — preserves the parallel-transport semantics while damping out any
      // jitter from sub-tick gravity oscillations.
      const smoothedFwd = lerpVec3(c0.pivot.fwd, transportedFwd, alpha);
      // Re-project onto the up-tangent plane to keep fwd ⊥ up after the lerp.
      const dFwdUp = dot(smoothedFwd, newUp);
      const fwdProj: Vec3 = [
        smoothedFwd[0] - dFwdUp * newUp[0],
        smoothedFwd[1] - dFwdUp * newUp[1],
        smoothedFwd[2] - dFwdUp * newUp[2],
      ];
      const fwdLen = Math.hypot(fwdProj[0], fwdProj[1], fwdProj[2]);
      const newFwd: Vec3 = fwdLen > 1e-6
        ? [fwdProj[0] / fwdLen, fwdProj[1] / fwdLen, fwdProj[2] / fwdLen]
        : transportedFwd;

      writeBuffer(camBuf, (c) => {
        c.pivot.position = [newPos[0], newPos[1], newPos[2]];
        c.pivot.up = [newUp[0], newUp[1], newUp[2]];
        c.pivot.fwd = [newFwd[0], newFwd[1], newFwd[2]];
        // Snapshot the followed character's body yaw so CameraOrbitSystem can
        // chase it without needing a separate transform-buffer read.
        c.state.followedBodyYaw = t.yaw;
      });
    },
  };
}
