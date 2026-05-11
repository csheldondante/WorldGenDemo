import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import {
  RIG_DEFINITION_BUFFER_ID,
  type RigDefinitionBufferData,
} from "../buffers/rigDefinition";
import { SKELETON_BUFFER_ID, type SkeletonBufferData } from "../buffers/skeleton";
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
  VOLUME_FIELD_BUFFER_ID,
  type VolumeFieldBufferData,
} from "../buffers/volumeField";
import { fromYaw, rotate, type Vec3, type Quat } from "../lib/math/quat";
import { quatFromTo } from "../lib/math/ik";
import { solveBodyUpTarget } from "../lib/math/leanSolver";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { SKELETON_WORLD_SYSTEM_ID } from "./skeletonWorld";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "./chainDynamics";
import { CAMERA_FOLLOW_SYSTEM_ID } from "./cameraFollow";

export const BODY_LEAN_SYSTEM_ID = "bodyLeanSystem";

/**
 * Inverted-pendulum body lean. For each character, computes the target
 * world-space body-up direction from the apparent-gravity solver (handles
 * slopes and acceleration cleanly), slerps `CharacterController.bodyUpCurrent`
 * toward it, then writes the pelvis `localRot` so the rendered body actually
 * tips that way. Also applies hip compression as a function of lean angle +
 * speed so the rig drops into a crouch at speed without snapping.
 *
 * Pelvis is owned exclusively by this system. `ChainDynamicsSystem` animates
 * spine bones above the pelvis for secondary motion; its biped rig chain
 * was updated to exclude bone 0.
 *
 * Math reference: `procedural_physical_locomotion_handoff.md` Stage 1.
 *   apparentG = gravity − projectToTangent(a_eff, surfaceNormal)
 *   bodyUp    = −normalize(apparentG)
 *
 * Where `a_eff = a_real + dragCoeff·v`. The drag term lets a steady forward
 * run produce a steady forward lean (real bipeds do this even at constant
 * velocity; pure inverted-pendulum physics says vertical at constant v).
 */
export function createBodyLeanSystem(): SystemDescriptor {
  return {
    id: BODY_LEAN_SYSTEM_ID,
    description:
      "Apparent-gravity body lean solver. Computes target body-up from gravity, velocity, accel and surface normal; smooths via slerp into CharacterController.bodyUpCurrent; writes pelvis localRot and pelvis compression. Pelvis owner; ChainDynamicsSystem animates spine bones only.",
    buffers: [
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: VELOCITY_BUFFER_ID, access: "read" },
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "read" },
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: SKELETON_BUFFER_ID, access: "readwrite" },
    ],
    // CameraFollow reads characterController and runs earlier in the graph
    // (after SurfaceConstraint, before us). The hazard checker requires the
    // edge to be explicit.
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID, CAMERA_FOLLOW_SYSTEM_ID],
    runsBefore: [CHAIN_DYNAMICS_SYSTEM_ID, SKELETON_WORLD_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const vels = readBuffer(buffer<VelocityBufferData>(VELOCITY_BUFFER_ID));
      const rigs = readBuffer(buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID));
      const surfaceAttach = readBuffer(buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID));
      const vfield = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const skelBuf = buffer<SkeletonBufferData>(SKELETON_BUFFER_ID);

      const skel = readBuffer(skelBuf);
      if (skel.byEntity.size === 0) return;

      const alpha = 1 - Math.exp(-Math.max(0, dt) * 8.0); // fallback if profile missing
      const gravity: Vec3 = [vfield.gravity[0], vfield.gravity[1], vfield.gravity[2]];

      writeBuffer(ccBuf, (cc) => {
        writeBuffer(skelBuf, (skelW) => {
          for (const [id, comp] of skelW.byEntity) {
            const rig = rigs.byId.get(comp.rigId);
            if (!rig || rig.bones.length === 0) continue;
            const t = transforms.byEntity.get(id);
            const v = vels.byEntity.get(id);
            if (!t || !v) continue;
            const ctrl = cc.byEntity.get(id);
            if (!ctrl) continue;
            const profile = profiles.byId.get(ctrl.profileId);
            if (!profile) continue;

            // Surface normal: grounded → surface sample; airborne → world up.
            const att = surfaceAttach.byEntity.get(id);
            const surfaceNormal: Vec3 =
              ctrl.locomotionMode === "surfaceConstrained" && att && att.sample
                ? [att.sample.normal[0], att.sample.normal[1], att.sample.normal[2]]
                : [0, 1, 0];

            // a_real includes the Y component so vertical-only jumps don't
            // tip the body sideways. The solver projects to tangent plane.
            const invDt = dt > 0 ? 1 / dt : 0;
            const accelReal: Vec3 = [
              (v.linear[0] - v.prevLinear[0]) * invDt,
              (v.linear[1] - v.prevLinear[1]) * invDt,
              (v.linear[2] - v.prevLinear[2]) * invDt,
            ];

            const { bodyUpTarget, leanAngle } = solveBodyUpTarget({
              velocity: [v.linear[0], v.linear[1], v.linear[2]],
              accelReal,
              surfaceNormal,
              gravity,
              dragCoeff: profile.leanDragCoeff,
            });

            // Clamp lean angle to profile.maxLeanAngle, preserving direction.
            const clampedTarget = clampBodyUpAngle(bodyUpTarget, surfaceNormal, leanAngle, profile.maxLeanAngle);

            // Express bodyUp in pelvis-local frame (inverse entity yaw) and
            // build a localRot quaternion from world-up to that direction.
            const invYaw = fromYaw(-t.yaw);
            const bodyUpLocal = rotate(invYaw, clampedTarget);
            const targetLocalRot = quatFromTo([0, 1, 0], bodyUpLocal);

            // Exponential smoothing on the quaternion toward target.
            const responsiveness = profile.leanResponsiveness > 0 ? profile.leanResponsiveness : 8.0;
            const a = 1 - Math.exp(-Math.max(0, dt) * responsiveness);
            ctrl.bodyUpCurrent = nlerp(ctrl.bodyUpCurrent as Quat, targetLocalRot, a);

            // Write pelvis localRot.
            const pelvisRot = comp.bones[0].localRot;
            pelvisRot[0] = ctrl.bodyUpCurrent[0];
            pelvisRot[1] = ctrl.bodyUpCurrent[1];
            pelvisRot[2] = ctrl.bodyUpCurrent[2];
            pelvisRot[3] = ctrl.bodyUpCurrent[3];

            // Hip compression: geometric (from current lean) + speed factor.
            const currentLeanMag = quatAngleFromIdentity(ctrl.bodyUpCurrent as Quat);
            const legLength = computeLegLength(rig);
            const leanDrop = legLength * (1 - Math.cos(currentLeanMag)) * profile.leanCompressionScale;
            const speedHoriz = Math.hypot(v.linear[0], v.linear[2]);
            const speedFactor = profile.desiredRunSpeed > 0 ? Math.min(1, speedHoriz / profile.desiredRunSpeed) : 0;
            const speedDrop = profile.pelvisSpeedCompression * speedFactor;
            const totalDrop = leanDrop + speedDrop;
            comp.bones[0].localPos[1] = rig.bones[0].bindLocalPos[1] - totalDrop;
          }
        });
      });

      void alpha;
    },
  };
}

/** Linear interpolate two quats, then normalize. Good enough for small per-tick blends. */
function nlerp(a: Quat, b: Quat, t: number): Quat {
  // Take the shorter arc by flipping b if dot < 0.
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const x = a[0] + (bx - a[0]) * t;
  const y = a[1] + (by - a[1]) * t;
  const z = a[2] + (bz - a[2]) * t;
  const w = a[3] + (bw - a[3]) * t;
  const inv = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
  return [x * inv, y * inv, z * inv, w * inv];
}

/** Angle a quaternion rotates by (twice the half-angle stored in w). */
function quatAngleFromIdentity(q: Quat): number {
  const w = Math.max(-1, Math.min(1, q[3]));
  return 2 * Math.acos(w);
}

/** Clamp the body-up angle from surface normal to `maxAngle`, preserving direction. */
function clampBodyUpAngle(bodyUp: Vec3, surfaceNormal: Vec3, currentAngle: number, maxAngle: number): Vec3 {
  if (currentAngle <= maxAngle || currentAngle < 1e-6) return bodyUp;
  // Project bodyUp onto the (normal, tangentToward(bodyUp)) plane, scale tangent by tan(maxAngle).
  const nDotUp = surfaceNormal[0] * bodyUp[0] + surfaceNormal[1] * bodyUp[1] + surfaceNormal[2] * bodyUp[2];
  const tangentX = bodyUp[0] - surfaceNormal[0] * nDotUp;
  const tangentY = bodyUp[1] - surfaceNormal[1] * nDotUp;
  const tangentZ = bodyUp[2] - surfaceNormal[2] * nDotUp;
  const tLen = Math.hypot(tangentX, tangentY, tangentZ);
  if (tLen < 1e-9) return bodyUp;
  const cosMax = Math.cos(maxAngle);
  const sinMax = Math.sin(maxAngle);
  const tx = tangentX / tLen;
  const ty = tangentY / tLen;
  const tz = tangentZ / tLen;
  return [
    surfaceNormal[0] * cosMax + tx * sinMax,
    surfaceNormal[1] * cosMax + ty * sinMax,
    surfaceNormal[2] * cosMax + tz * sinMax,
  ];
}

/** Leg length from the rig: |knee.bindLocalPos| + |foot.bindLocalPos| using leg 0. */
function computeLegLength(rig: { bones: { bindLocalPos: [number, number, number] }[]; legs: { kneeBone: number; footBone: number }[] }): number {
  if (rig.legs.length === 0) return 0.8;
  const leg = rig.legs[0];
  const knee = rig.bones[leg.kneeBone].bindLocalPos;
  const foot = rig.bones[leg.footBone].bindLocalPos;
  return Math.hypot(knee[0], knee[1], knee[2]) + Math.hypot(foot[0], foot[1], foot[2]);
}

