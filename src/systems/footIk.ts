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
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../buffers/surfaceProvider";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../buffers/characterController";
import { CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, type CharacterControllerProfileBufferData } from "../buffers/characterControllerProfile";
import { fromYaw, mul, rotate, type Vec3 } from "../lib/math/quat";
import { twoBoneIK } from "../lib/math/ik";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "./chainDynamics";
import { SKELETON_WORLD_SYSTEM_ID } from "./skeletonWorld";

export const FOOT_IK_SYSTEM_ID = "footIkSystem";

/**
 * Plants feet on the surface via analytic 2-bone IK.
 *
 * Per leg, per entity:
 *   1. Compute the hip's world position (entity transform → pelvis lean →
 *      hipBone.bindLocalPos). Pelvis lean is already in `pelvis.localRot`
 *      because ChainDynamicsSystem ran just before us.
 *   2. Query the surface provider directly below the hip's world XZ.
 *   3. Pick a foot target = surface point + a small `footClearance` offset
 *      along the surface normal so the foot sits *on* the surface, not in it.
 *   4. Solve 2-bone IK in pelvis-local frame; write upperLeg and lowerLeg
 *      localRots.
 *
 * Why pelvis-local rather than world: the IK output we need is bone *local*
 * rotation (parent-relative), so it's cleaner to express the target there
 * directly than to solve in world and convert back.
 *
 * Why "directly below the hip" rather than a gait plant point: this is the
 * Phase 1C v1 — the legs flex statically to maintain ground contact. Gait
 * (alternating fore/aft plant positions over a stride cycle) is a Phase 1C v2
 * addition that just changes the target — IK math stays the same.
 *
 * Skips entities not in `surfaceConstrained` locomotion (mid-jump / mid-glide
 * keep their bind-pose legs since there's nothing to plant on).
 */
export function createFootIkSystem(): SystemDescriptor {
  return {
    id: FOOT_IK_SYSTEM_ID,
    description:
      "Per-entity, per-leg 2-bone IK. Computes hip world pos via partial FK (entity transform composed with pelvis lean), samples SurfaceProvider for foot plant, solves twoBoneIK in pelvis-local frame, writes upperLeg and lowerLeg localRots.",
    buffers: [
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SKELETON_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHAIN_DYNAMICS_SYSTEM_ID],
    runsBefore: [SKELETON_WORLD_SYSTEM_ID],
    execute: ({ buffer }) => {
      const rigs = readBuffer(buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID));
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
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

          // Composed yaw + pelvis lean → world-direction quaternion that takes
          // pelvis-local vectors to world. Pelvis is the rig root (parent = -1)
          // so its localRot is relative to the entity transform.
          const yawQ = fromYaw(t.yaw);
          const pelvisLocalRot = comp.bones[0].localRot;
          const pelvisWorldRot = mul(yawQ, pelvisLocalRot);
          const pelvisWorldPos: Vec3 = [t.position[0], t.position[1], t.position[2]];

          for (const leg of rig.legs) {
            applyLegIK(leg, rig, comp.bones, pelvisWorldRot, pelvisWorldPos, surface, profile.bodyRadius);
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
  pelvisWorldRot: [number, number, number, number],
  pelvisWorldPos: Vec3,
  surface: NonNullable<SurfaceProviderBufferData["heightmap"]>,
  bodyRadius: number,
): void {
  const hipBone = rig.bones[leg.hipBone];
  const kneeBone = rig.bones[leg.kneeBone];
  const footBone = rig.bones[leg.footBone];
  assertDev(
    hipBone.parent === 0 && kneeBone.parent === leg.hipBone && footBone.parent === leg.kneeBone,
    `FootIK: leg "${leg.name}" topology must be pelvis → hip → knee → foot`,
  );

  // Bone lengths derived from bind pose. Knee/foot bind-local positions are
  // offsets in their parent's frame at rest; their magnitudes are the bone
  // lengths. For our biped both are 0.4.
  const L1 = Math.hypot(kneeBone.bindLocalPos[0], kneeBone.bindLocalPos[1], kneeBone.bindLocalPos[2]);
  const L2 = Math.hypot(footBone.bindLocalPos[0], footBone.bindLocalPos[1], footBone.bindLocalPos[2]);

  // Hip position in world: pelvisWorldPos + pelvisWorldRot · hipBone.bindLocalPos.
  const hipOffsetWorld = rotate(pelvisWorldRot, hipBone.bindLocalPos);
  const hipWorld: Vec3 = [
    pelvisWorldPos[0] + hipOffsetWorld[0],
    pelvisWorldPos[1] + hipOffsetWorld[1],
    pelvisWorldPos[2] + hipOffsetWorld[2],
  ];

  // Surface sample directly below the hip (XZ projection). Skip if outside
  // the heightmap — leg stays at bind pose.
  const [u, v] = surface.worldToUV(hipWorld[0], hipWorld[2]);
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  const sample = surface.sampleAtUV(u, v);

  // Foot clearance: lift the foot slightly along the surface normal so it
  // doesn't poke through the terrain. ~5cm matches the visible debug bone scale.
  const FOOT_CLEARANCE = 0.05;
  const footTargetWorld: Vec3 = [
    sample.position[0] + sample.normal[0] * FOOT_CLEARANCE,
    sample.position[1] + sample.normal[1] * FOOT_CLEARANCE,
    sample.position[2] + sample.normal[2] * FOOT_CLEARANCE,
  ];

  // Transform hip and footTarget into pelvis-local frame. IK then yields the
  // upperLeg.localRot (relative to pelvis = parent) directly.
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

  // Sanity: targetLocal Y should be below rootLocal Y (foot below hip).
  // If somehow above (e.g. hip below ground), clamp to keep IK well-defined.
  if (targetLocal[1] > rootLocal[1]) {
    targetLocal[1] = rootLocal[1] - 0.01;
  }
  // Limit how far we ask the foot to reach so legs don't bend bizarrely on
  // cliffs taller than the leg's reach. Reach is L1+L2, with a small margin.
  const dropMax = (L1 + L2) - 0.02;
  if (rootLocal[1] - targetLocal[1] > dropMax) {
    targetLocal[1] = rootLocal[1] - dropMax;
  }
  // Also keep horizontal offset reasonable (the foot below the hip).
  // For Phase 1C v1 we don't model stride, so foot is directly under hip.
  targetLocal[0] = rootLocal[0];
  targetLocal[2] = rootLocal[2];
  // Re-clamp Y after horizontal reset (keeps foot below hip).
  targetLocal[1] = Math.min(targetLocal[1], rootLocal[1] - bodyRadius * 0.5);

  const { upper, lower } = twoBoneIK(rootLocal, targetLocal, leg.kneePoleDir, L1, L2, [0, -1, 0]);

  // Write into per-bone localRots. upper rotates upperLeg in pelvis-frame;
  // lower rotates lowerLeg in upperLeg-frame.
  const up = bones[leg.hipBone].localRot;
  up[0] = upper[0]; up[1] = upper[1]; up[2] = upper[2]; up[3] = upper[3];
  const lo = bones[leg.kneeBone].localRot;
  lo[0] = lower[0]; lo[1] = lower[1]; lo[2] = lower[2]; lo[3] = lower[3];
}

function quatConjugate(q: [number, number, number, number]): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]];
}
