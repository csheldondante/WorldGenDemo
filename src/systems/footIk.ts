import { readBuffer, writeBuffer } from "../runtime/buffer";
import { assertDev } from "../runtime/dev";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import {
  RIG_DEFINITION_BUFFER_ID,
  type RigDefinitionBufferData,
  type RigDefinition,
  type LegSpec,
} from "../buffers/rigDefinition";
import { SKELETON_BUFFER_ID, type SkeletonBufferData, type BoneState } from "../buffers/skeleton";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../buffers/surfaceProvider";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
  type CharacterControllerComponent,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
  type CharacterControllerProfile,
} from "../buffers/characterControllerProfile";
import { fromYaw, mul, rotate, type Vec3 } from "../lib/math/quat";
import { twoBoneIK } from "../lib/math/ik";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "./chainDynamics";
import { SKELETON_WORLD_SYSTEM_ID } from "./skeletonWorld";
import { GAIT_SYSTEM_ID } from "./gait";

export const FOOT_IK_SYSTEM_ID = "footIkSystem";
const FOOT_CLEARANCE = 0.05;

/**
 * Plants feet on the surface via analytic 2-bone IK, with a gait cycle that
 * makes each leg step alternately as the character moves.
 *
 * Per leg, per entity:
 *   1. Compute the hip's world position (entity transform → pelvis lean →
 *      hipBone.bindLocalPos). Pelvis lean comes from ChainDynamicsSystem.
 *   2. Compute this foot's gait state from `ctrl.gaitPhase + leg.gaitPhaseOffset`.
 *      Stride length = `speed / (2·stepFreq)`. Foot's local-Z offset in body
 *      frame is `(stride/2)·cos(footPhase)`. Vertical lift during swing is
 *      `max(0, sin(footPhase)) · stepHeight · stride_normalized`.
 *   3. Apply the body-frame offset (yaw-rotated to world), then sample the
 *      surface at the foot's stepping XZ — not under the hip.
 *   4. Foot target = surface plant point + surface-normal clearance + world-up
 *      lift. Solve 2-bone IK in pelvis-local frame; write upperLeg + lowerLeg
 *      localRots.
 *
 * Stride math: during stance (footPhase ∈ [π, 2π]) the foot's body-local Z
 * advances at rate `stride / T_stance = speed`, which exactly cancels the
 * character's forward velocity — so the foot stays roughly stationary in
 * world while the body strides over it. During swing (footPhase ∈ [0, π])
 * the foot lifts and moves forward to the next plant point.
 *
 * Skips entities not in `surfaceConstrained` locomotion (mid-jump / mid-glide
 * keep their bind-pose legs since there's nothing to plant on).
 */
export function createFootIkSystem(): SystemDescriptor {
  return {
    id: FOOT_IK_SYSTEM_ID,
    description:
      "Per-entity, per-leg 2-bone IK with gait. Reads gaitPhase + speed to compute each foot's stride offset and swing lift, samples SurfaceProvider for the plant point, then solves twoBoneIK in pelvis-local frame and writes upperLeg/lowerLeg localRots.",
    buffers: [
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: VELOCITY_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SKELETON_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHAIN_DYNAMICS_SYSTEM_ID, GAIT_SYSTEM_ID],
    runsBefore: [SKELETON_WORLD_SYSTEM_ID],
    execute: ({ buffer }) => {
      const rigs = readBuffer(buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID));
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const vels = readBuffer(buffer<VelocityBufferData>(VELOCITY_BUFFER_ID));
      const surfaceProv = readBuffer(buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const skelBuf = buffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
      const skel = readBuffer(skelBuf);
      if (skel.byEntity.size === 0) return;
      const surface = surfaceProv.heightmap;
      if (!surface) return;

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
          const v = vels.byEntity.get(id);
          const speed = v ? Math.hypot(v.linear[0], v.linear[2]) : 0;

          // Composed yaw + pelvis lean → world-direction quaternion that takes
          // pelvis-local vectors to world. Pelvis is the rig root.
          const yawQ = fromYaw(t.yaw);
          const pelvisLocalRot = comp.bones[0].localRot;
          const pelvisWorldRot = mul(yawQ, pelvisLocalRot);
          // The body-frame stride direction (forward = -Z body) uses the
          // entity yaw only — not pelvis lean — so the stride stays in the
          // horizontal plane even while the spine tilts.
          const bodyYawRot = yawQ;
          const pelvisWorldPos: Vec3 = [t.position[0], t.position[1], t.position[2]];

          for (const leg of rig.legs) {
            applyLegIK(leg, rig, comp.bones, ctrl, profile, speed, pelvisWorldRot, bodyYawRot, pelvisWorldPos, surface);
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
  ctrl: CharacterControllerComponent,
  profile: CharacterControllerProfile,
  speed: number,
  pelvisWorldRot: [number, number, number, number],
  bodyYawRot: [number, number, number, number],
  pelvisWorldPos: Vec3,
  surface: NonNullable<SurfaceProviderBufferData["heightmap"]>,
): void {
  const hipBone = rig.bones[leg.hipBone];
  const kneeBone = rig.bones[leg.kneeBone];
  const footBone = rig.bones[leg.footBone];
  assertDev(
    hipBone.parent === 0 && kneeBone.parent === leg.hipBone && footBone.parent === leg.kneeBone,
    `FootIK: leg "${leg.name}" topology must be pelvis → hip → knee → foot`,
  );
  const L1 = Math.hypot(kneeBone.bindLocalPos[0], kneeBone.bindLocalPos[1], kneeBone.bindLocalPos[2]);
  const L2 = Math.hypot(footBone.bindLocalPos[0], footBone.bindLocalPos[1], footBone.bindLocalPos[2]);

  // Hip world position via pelvis-tilted offset.
  const hipOffsetWorld = rotate(pelvisWorldRot, hipBone.bindLocalPos);
  const hipWorld: Vec3 = [
    pelvisWorldPos[0] + hipOffsetWorld[0],
    pelvisWorldPos[1] + hipOffsetWorld[1],
    pelvisWorldPos[2] + hipOffsetWorld[2],
  ];

  // ----- Gait offset & lift ---------------------------------------------
  // Single-leg phase = global gait phase + this leg's offset.
  // Stride length grows with speed (and vanishes at rest); see system docstring.
  const TAU = Math.PI * 2;
  const footPhase = ((ctrl.gaitPhase + leg.gaitPhaseOffset) % TAU + TAU) % TAU;
  const stepFreq = profile.gaitBaseFreq + profile.gaitSpeedFreq * speed;
  const stride = speed >= profile.gaitMinSpeed && stepFreq > 1e-4
    ? speed / (2 * stepFreq)
    : 0;
  // Body-local Z offset: +Z is behind the character, -Z is in front (three.js convention).
  // cos(0)=+1 → foot behind (planted at start). cos(π)=-1 → foot in front (just planted).
  const zLocal = (stride / 2) * Math.cos(footPhase);
  // Swing lift only during phase 0..π (sin > 0). Scaled by stride normalization
  // so at very low speeds the lift fades naturally with stride.
  const STRIDE_REF = 0.5;
  const liftScale = Math.min(1, stride / STRIDE_REF);
  const yLift = Math.max(0, Math.sin(footPhase)) * profile.gaitStepHeight * liftScale;

  // Rotate body-local stride offset to world by the entity yaw (no pelvis
  // tilt — stride stays in horizontal plane). Plant point's XZ.
  const strideWorld = rotate(bodyYawRot, [0, 0, zLocal]);
  const plantX = hipWorld[0] + strideWorld[0];
  const plantZ = hipWorld[2] + strideWorld[2];

  // Surface sample at the plant XZ. Skip the leg if outside the heightmap.
  const [u, v] = surface.worldToUV(plantX, plantZ);
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  const sample = surface.sampleAtUV(u, v);

  const footTargetWorld: Vec3 = [
    sample.position[0] + sample.normal[0] * FOOT_CLEARANCE,
    sample.position[1] + sample.normal[1] * FOOT_CLEARANCE + yLift,
    sample.position[2] + sample.normal[2] * FOOT_CLEARANCE,
  ];

  // ----- Solve IK in pelvis-local frame --------------------------------
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
  // Keep foot below the hip in body-local frame; reach clamped to L1+L2-eps.
  if (targetLocal[1] > rootLocal[1] - 0.01) targetLocal[1] = rootLocal[1] - 0.01;
  const dropMax = (L1 + L2) - 0.02;
  if (rootLocal[1] - targetLocal[1] > dropMax) {
    // Foot can't reach: pull the target up to max reach, preserving horizontal
    // direction so the leg still points at the stepping spot.
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
