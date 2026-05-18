import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import {
  CHARACTER_INPUT_BUFFER_ID,
  type CharacterInputBufferData,
} from "../buffers/characterInput";
import {
  CHARACTER_TANGENT_INPUT_BUFFER_ID,
  type CharacterTangentInputBufferData,
} from "../buffers/characterTangentInput";
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
  FORCE_ACCUMULATOR_BUFFER_ID,
  type ForceAccumulatorBufferData,
} from "../buffers/forceAccumulator";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { CHARACTER_ORIENTATION_SYSTEM_ID } from "./characterOrientation";
import { FORCE_FIELD_SYSTEM_ID } from "./forceField";
import { xInterceptShifted } from "../lib/math/accelCurve";
import { projectCameraTangentForward } from "../lib/math/cameraTangent";
import type { Vec3 } from "../lib/math/quat";

export const TANGENT_INPUT_MAPPER_SYSTEM_ID = "tangentInputMapperSystem";

/**
 * Projects player input + camera yaw onto the surface tangent plane at each
 * surface-attached character, producing the orthonormal basis the controller solves in
 * and the desired-velocity scalars (vDesF, vDesR) along that basis.
 *
 * Before this system existed, `CharacterControllerSystem` did this projection inline.
 * Splitting it out makes the controller's role purer ("given a tangent frame + desired
 * tangent velocity, compute the required acceleration") and lets future input variants
 * (e.g., AI characters, replay) write straight into `CharacterTangentInputBuffer`
 * without going through camera math.
 *
 * The math is unchanged from the prior inline form (kept byte-identical during the B.1
 * refactor): camera-yaw forward in world XZ → project off surface normal → unit Ft →
 * Rt = Ft × N (right-handed). Desired velocities are scaled by `profile.desiredRunSpeed`.
 *
 * Only surface-attached entities are processed; airborne entities have no meaningful
 * tangent frame and the controller's airborne path doesn't read this buffer.
 */
export function createTangentInputMapperSystem(): SystemDescriptor {
  return {
    id: TANGENT_INPUT_MAPPER_SYSTEM_ID,
    description:
      "Projects per-character input + camera yaw onto the surface tangent plane. Writes the orthonormal tangent basis (forwardTangent, rightTangent) and desired-velocity scalars (vDesF, vDesR) into CharacterTangentInputBuffer for every surface-attached character. CharacterControllerSystem consumes this instead of recomputing the projection itself.",
    buffers: [
      { id: CHARACTER_INPUT_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "read" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "read" },
      { id: CHARACTER_TANGENT_INPUT_BUFFER_ID, access: "readwrite" },
    ],
    // Ordering:
    //  - after CHARACTER_INPUT_SYSTEM_ID so move axes are populated.
    //  - after CHARACTER_ORIENTATION_SYSTEM_ID so we read the post-orientation
    //    characterController (orientation writes yaw / orientation quat; orientation
    //    itself `runsBefore` forceField).
    //  - after FORCE_FIELD_SYSTEM_ID so the accumulator's external accel is populated
    //    and the shifted x-intercept reflects current gravity / volume / wind / etc.
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      CHARACTER_INPUT_SYSTEM_ID,
      CHARACTER_ORIENTATION_SYSTEM_ID,
      FORCE_FIELD_SYSTEM_ID,
    ],
    execute: ({ buffer }) => {
      const ci = readBuffer(buffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const sa = readBuffer(buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID));
      const fa = readBuffer(buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID));
      const tiBuf = buffer<CharacterTangentInputBufferData>(CHARACTER_TANGENT_INPUT_BUFFER_ID);

      writeBuffer(tiBuf, (d) => {
        for (const [id, ctrl] of cc.byEntity) {
          if (ctrl.locomotionMode !== "surfaceConstrained") continue;
          const input = ci.byEntity.get(id);
          const att = sa.byEntity.get(id);
          const profile = profiles.byId.get(ctrl.profileId);
          if (!input || !att || !profile) continue;
          const sample = att.sample;
          if (!sample) continue;

          // Project whichever of {camera lookDir F, camera up U} is more
          // tangent to the surface (smaller |·N|) onto the tangent plane.
          // The legacy F-only rule degraded as F approached N (steep-hill
          // crest, torus inside curl, vertical wall + elevated camera all
          // hit that regime). See `src/lib/math/cameraTangent.ts`.
          const F: Vec3 = [
            input.cameraLookDir[0], input.cameraLookDir[1], input.cameraLookDir[2],
          ];
          const U: Vec3 = [
            input.cameraUp[0], input.cameraUp[1], input.cameraUp[2],
          ];
          const N: Vec3 = [sample.normal[0], sample.normal[1], sample.normal[2]];
          const basis = projectCameraTangentForward(F, U, N);
          if (!basis.forward) continue;
          const FtX = basis.forward[0], FtY = basis.forward[1], FtZ = basis.forward[2];
          const RtX = basis.right![0], RtY = basis.right![1], RtZ = basis.right![2];

          // Project the per-entity external accel (gravity-along-tangent etc.) onto
          // Ft and Rt. This is what shifts each direction's accel curve. On a downhill
          // gravity has a positive component along Ft → curve shifts UP → x-intercept
          // moves to a faster sustainable speed. See
          // `wiki/worldgen-demo-accel-curve-and-desired-velocity.md`.
          const accel = fa.byEntity.get(id)?.accel ?? [0, 0, 0];
          const aExF = accel[0] * FtX + accel[1] * FtY + accel[2] * FtZ;
          const aExR = accel[0] * RtX + accel[1] * RtY + accel[2] * RtZ;

          // Desired velocity along each axis = input fraction × x-intercept of the
          // shifted biomechanical curve. Sign-aware: forward intent uses forwardAccel
          // shifted by +aExF; backward intent uses backwardAccel shifted by −aExF
          // (because backward's reference direction is −F̂, so the external projection
          // is negated).
          const vDesF =
            input.moveY >= 0
              ? input.moveY * xInterceptShifted(profile.forwardAccel, aExF)
              : input.moveY * xInterceptShifted(profile.backwardAccel, -aExF);
          const vDesR =
            input.moveX >= 0
              ? input.moveX * xInterceptShifted(profile.lateralAccel, aExR)
              : input.moveX * xInterceptShifted(profile.lateralAccel, -aExR);

          d.byEntity.set(id, {
            forwardTangent: [FtX, FtY, FtZ],
            rightTangent: [RtX, RtY, RtZ],
            vDesF,
            vDesR,
          });
        }
      });
    },
  };
}
