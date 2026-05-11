import { readBuffer, writeBuffer } from "../runtime/buffer";
import { assertDev } from "../runtime/dev";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  RIG_DEFINITION_BUFFER_ID,
  type RigDefinitionBufferData,
  type RigDefinition,
  type LegSpec,
} from "../buffers/rigDefinition";
import { SKELETON_BUFFER_ID, type SkeletonBufferData, type BoneState } from "../buffers/skeleton";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
  type CharacterControllerProfile,
} from "../buffers/characterControllerProfile";
import {
  FOOT_LOCK_BUFFER_ID,
  type FootLockBufferData,
  type FootLockState,
} from "../buffers/footLock";
import {
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../buffers/surfaceAttachment";
import { fromYaw, mul, rotate, type Vec3 } from "../lib/math/quat";
import { quatFromTo, quatInv } from "../lib/math/ik";
import { twoBoneIK } from "../lib/math/ik";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "./chainDynamics";
import { FOOT_PLANNER_SYSTEM_ID } from "./footPlanner";
import { SKELETON_WORLD_SYSTEM_ID } from "./skeletonWorld";

export const FOOT_IK_SYSTEM_ID = "footIkSystem";

/** Airborne pose: each foot hangs `AIRBORNE_FOOT_DROP` below its hip in
 *  pelvis-local frame, and `AIRBORNE_FOOT_FORWARD` ahead of it (along body
 *  forward = -Z body-local). Distance to hip is ~0.56 m, comfortably under
 *  the 0.8 m max leg reach, so knees bend visibly mid-air rather than
 *  dangling straight down or stretching out behind. */
const AIRBORNE_FOOT_DROP = 0.55;
const AIRBORNE_FOOT_FORWARD = 0.10;

/**
 * Solves 2-bone IK per leg. Two paths depending on locomotion mode:
 *
 * - `surfaceConstrained` → reads `FootLockBuffer` for the planner-managed
 *   world plant + swing progress; adds a vertical lift curve while swinging.
 * - `volumeConstrained` (airborne / glide / etc.) → ignores the planner and
 *   targets a body-relative resting pose (feet under-and-slightly-ahead of
 *   each hip). Knees bend automatically into a tucked-but-reaching shape;
 *   when the character lands, `FootPlannerSystem` lazy-inits the plants and
 *   the surface path takes over.
 *
 * Why two systems instead of one: `FootPlannerSystem` owns plant logic + state
 * machine (when a foot lifts, where it lands). `FootIKSystem` owns the bone
 * math (given a target, derive the upper/lower leg local rotations). Each
 * test surface stays narrow.
 *
 * Future:
 *  - Split the airborne pose into ascent/descent phases (read v.linear[1]):
 *    tuck higher on the way up, reach further forward on the way down for
 *    landing.
 *  - When `surfaceSlide` state starts being produced, route it as a third
 *    path: legs stay locked straight while plantPos drags along velocity.
 */
export function createFootIkSystem(): SystemDescriptor {
  return {
    id: FOOT_IK_SYSTEM_ID,
    description:
      "Per-leg 2-bone IK. Surface-constrained: reads FootLockBuffer for plant + swing. Volume-constrained: body-relative airborne pose. Writes upperLeg/lowerLeg localRots.",
    buffers: [
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: FOOT_LOCK_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "read" },
      { id: SKELETON_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHAIN_DYNAMICS_SYSTEM_ID, FOOT_PLANNER_SYSTEM_ID],
    runsBefore: [SKELETON_WORLD_SYSTEM_ID],
    execute: ({ buffer }) => {
      const rigs = readBuffer(buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID));
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const locks = readBuffer(buffer<FootLockBufferData>(FOOT_LOCK_BUFFER_ID));
      const surfaceAttach = readBuffer(buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID));
      const skelBuf = buffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
      const skel = readBuffer(skelBuf);
      if (skel.byEntity.size === 0) return;

      writeBuffer(skelBuf, (d) => {
        for (const [id, comp] of d.byEntity) {
          const rig = rigs.byId.get(comp.rigId);
          if (!rig || rig.legs.length === 0) continue;
          const t = transforms.byEntity.get(id);
          if (!t) continue;
          const ctrl = cc.byEntity.get(id);
          if (!ctrl) continue;
          const profile = profiles.byId.get(ctrl.profileId);
          if (!profile) continue;

          const yawQ = fromYaw(t.yaw);
          const pelvisLocalRot = comp.bones[0].localRot;
          const pelvisWorldRot = mul(yawQ, pelvisLocalRot);
          const pelvisWorldPos: Vec3 = [t.position[0], t.position[1], t.position[2]];

          if (ctrl.locomotionMode === "surfaceConstrained") {
            const footStates = locks.byEntity.get(id);
            if (!footStates || footStates.length !== rig.legs.length) continue;
            // Surface normal for foot-plant orientation (defaults to world up
            // if no attachment yet). Same normal for both feet — fine on flat
            // ground; per-foot sampling at plant points is a follow-up.
            const att = surfaceAttach.byEntity.get(id);
            const surfaceNormalWorld: Vec3 = att && att.sample
              ? [att.sample.normal[0], att.sample.normal[1], att.sample.normal[2]]
              : [0, 1, 0];
            for (let i = 0; i < rig.legs.length; i++) {
              applyLegIK(rig.legs[i], rig, comp.bones, footStates[i], profile, pelvisWorldRot, pelvisWorldPos, surfaceNormalWorld);
            }
          } else {
            // Airborne / volume-constrained: targets are body-relative.
            for (const leg of rig.legs) {
              applyAirborneLegIK(leg, rig, comp.bones);
            }
          }
        }
      });
    },
  };
}

function applyLegIK(
  leg: LegSpec,
  rig: RigDefinition,
  bones: BoneState[],
  lock: FootLockState,
  profile: CharacterControllerProfile,
  pelvisWorldRot: [number, number, number, number],
  pelvisWorldPos: Vec3,
  surfaceNormalWorld: Vec3,
): void {
  if (!lock.initialized) return;

  const hipBone = rig.bones[leg.hipBone];
  const kneeBone = rig.bones[leg.kneeBone];
  const footBone = rig.bones[leg.footBone];
  assertDev(
    hipBone.parent === 0 && kneeBone.parent === leg.hipBone && footBone.parent === leg.kneeBone,
    `FootIK: leg "${leg.name}" topology must be pelvis → hip → knee → foot`,
  );
  const L1 = Math.hypot(kneeBone.bindLocalPos[0], kneeBone.bindLocalPos[1], kneeBone.bindLocalPos[2]);
  const L2 = Math.hypot(footBone.bindLocalPos[0], footBone.bindLocalPos[1], footBone.bindLocalPos[2]);

  const hipOffsetWorld = rotate(pelvisWorldRot, hipBone.bindLocalPos);
  const hipWorld: Vec3 = [
    pelvisWorldPos[0] + hipOffsetWorld[0],
    pelvisWorldPos[1] + hipOffsetWorld[1],
    pelvisWorldPos[2] + hipOffsetWorld[2],
  ];

  // Foot target in world: planner-managed plant position, plus a vertical lift
  // curve while swinging. Lift peaks at swingT=0.5 and returns to 0 at the
  // endpoints (sin(π·t)) — clears the path between previous and new plants.
  const footTargetWorld: Vec3 = [lock.plantPos[0], lock.plantPos[1], lock.plantPos[2]];
  if (lock.state === "swinging") {
    const lift = Math.sin(Math.PI * lock.swingT) * profile.footStepHeight;
    footTargetWorld[1] += lift;
  }

  const invPelvis = quatConjugate(pelvisWorldRot);
  const rootLocal = rotate(invPelvis, [
    hipWorld[0] - pelvisWorldPos[0],
    hipWorld[1] - pelvisWorldPos[1],
    hipWorld[2] - pelvisWorldPos[2],
  ]);
  const targetLocal = rotate(invPelvis, [
    footTargetWorld[0] - pelvisWorldPos[0],
    footTargetWorld[1] - pelvisWorldPos[1],
    footTargetWorld[2] - pelvisWorldPos[2],
  ]);

  if (targetLocal[1] > rootLocal[1] - 0.01) targetLocal[1] = rootLocal[1] - 0.01;
  const dropMax = (L1 + L2) - 0.02;
  if (rootLocal[1] - targetLocal[1] > dropMax) {
    const horiz = Math.hypot(targetLocal[0] - rootLocal[0], targetLocal[2] - rootLocal[2]);
    const scale = horiz > 0 ? Math.min(1, (L1 + L2) / Math.hypot(horiz, dropMax)) : 1;
    targetLocal[0] = rootLocal[0] + (targetLocal[0] - rootLocal[0]) * scale;
    targetLocal[2] = rootLocal[2] + (targetLocal[2] - rootLocal[2]) * scale;
    targetLocal[1] = rootLocal[1] - dropMax;
  }

  const { upper, lower } = twoBoneIK(rootLocal, targetLocal, leg.kneePoleDir, L1, L2, [0, -1, 0]);
  const up = bones[leg.hipBone].localRot;
  up[0] = upper[0]; up[1] = upper[1]; up[2] = upper[2]; up[3] = upper[3];
  const lo = bones[leg.kneeBone].localRot;
  lo[0] = lower[0]; lo[1] = lower[1]; lo[2] = lower[2]; lo[3] = lower[3];

  // Foot orientation: align foot's local +Y to the surface normal so the
  // sole sits flat. We need to express that target as a rotation in the
  // foot's parent frame (lower leg). Build lowerLegWorldRot from the chain
  // we just wrote: pelvisWorld · upper · lower. Then foot.localRot rotates
  // the parent's local Y to point along surfaceNormal_in_lowerLeg_frame.
  const lowerLegWorldRot = mul(mul(pelvisWorldRot, upper), lower);
  const surfaceNormalInLowerLeg = rotate(quatInv(lowerLegWorldRot), surfaceNormalWorld);
  const footAlign = quatFromTo([0, 1, 0], surfaceNormalInLowerLeg);
  const fo = bones[leg.footBone].localRot;
  fo[0] = footAlign[0]; fo[1] = footAlign[1]; fo[2] = footAlign[2]; fo[3] = footAlign[3];
}

/**
 * Airborne pose: in pelvis-local frame, target = hip + (0, -drop, -forward).
 * No surface query, no plant state. Knees fall into a natural tucked-but-
 * reaching pose. The whole solve is local so it doesn't care about the
 * character's world position or any planner state — when the character
 * lands, FootPlannerSystem lazy-inits fresh plants and the surface path
 * takes over with no transition seam to manage here.
 */
function applyAirborneLegIK(
  leg: LegSpec,
  rig: RigDefinition,
  bones: BoneState[],
): void {
  const hipBone = rig.bones[leg.hipBone];
  const kneeBone = rig.bones[leg.kneeBone];
  const footBone = rig.bones[leg.footBone];
  const L1 = Math.hypot(kneeBone.bindLocalPos[0], kneeBone.bindLocalPos[1], kneeBone.bindLocalPos[2]);
  const L2 = Math.hypot(footBone.bindLocalPos[0], footBone.bindLocalPos[1], footBone.bindLocalPos[2]);

  const rootLocal: Vec3 = [hipBone.bindLocalPos[0], hipBone.bindLocalPos[1], hipBone.bindLocalPos[2]];
  const targetLocal: Vec3 = [
    hipBone.bindLocalPos[0],
    hipBone.bindLocalPos[1] - AIRBORNE_FOOT_DROP,
    hipBone.bindLocalPos[2] - AIRBORNE_FOOT_FORWARD,
  ];

  const { upper, lower } = twoBoneIK(rootLocal, targetLocal, leg.kneePoleDir, L1, L2, [0, -1, 0]);
  const up = bones[leg.hipBone].localRot;
  up[0] = upper[0]; up[1] = upper[1]; up[2] = upper[2]; up[3] = upper[3];
  const lo = bones[leg.kneeBone].localRot;
  lo[0] = lower[0]; lo[1] = lower[1]; lo[2] = lower[2]; lo[3] = lower[3];
}

function quatConjugate(q: [number, number, number, number]): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]];
}
