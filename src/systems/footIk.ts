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
import { fromYaw, mul, rotate, type Vec3 } from "../lib/math/quat";
import { twoBoneIK } from "../lib/math/ik";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "./chainDynamics";
import { FOOT_PLANNER_SYSTEM_ID } from "./footPlanner";
import { SKELETON_WORLD_SYSTEM_ID } from "./skeletonWorld";

export const FOOT_IK_SYSTEM_ID = "footIkSystem";

/**
 * Solves 2-bone IK per leg so each foot lands at the world position chosen by
 * `FootPlannerSystem`. While the foot is `"swinging"`, an additional vertical
 * lift curve raises the foot above the lerped path so it clears the ground.
 *
 * Why two systems instead of one: `FootPlannerSystem` owns plant logic + state
 * machine (when a foot lifts, where it lands). `FootIKSystem` owns the bone
 * math (given a world target, derive the upper/lower leg local rotations).
 * Splitting them keeps each test surface narrow.
 */
export function createFootIkSystem(): SystemDescriptor {
  return {
    id: FOOT_IK_SYSTEM_ID,
    description:
      "Per-leg 2-bone IK. Reads FootLockBuffer for each foot's target world position and swing progress, adds a vertical lift curve during swing, and solves twoBoneIK in pelvis-local frame to produce upperLeg + lowerLeg localRots.",
    buffers: [
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: FOOT_LOCK_BUFFER_ID, access: "read" },
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
          if (!ctrl || ctrl.locomotionMode !== "surfaceConstrained") continue;
          const profile = profiles.byId.get(ctrl.profileId);
          if (!profile) continue;
          const footStates = locks.byEntity.get(id);
          if (!footStates || footStates.length !== rig.legs.length) continue;

          const yawQ = fromYaw(t.yaw);
          const pelvisLocalRot = comp.bones[0].localRot;
          const pelvisWorldRot = mul(yawQ, pelvisLocalRot);
          const pelvisWorldPos: Vec3 = [t.position[0], t.position[1], t.position[2]];

          for (let i = 0; i < rig.legs.length; i++) {
            applyLegIK(rig.legs[i], rig, comp.bones, footStates[i], profile, pelvisWorldRot, pelvisWorldPos);
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
}

function quatConjugate(q: [number, number, number, number]): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]];
}
