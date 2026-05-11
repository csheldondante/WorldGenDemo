import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import {
  RIG_DEFINITION_BUFFER_ID,
  type RigDefinitionBufferData,
  type LegSpec,
} from "../buffers/rigDefinition";
import { SKELETON_BUFFER_ID, type SkeletonBufferData } from "../buffers/skeleton";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../buffers/surfaceProvider";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import {
  FOOT_LOCK_BUFFER_ID,
  type FootLockBufferData,
  type FootLockState,
  makeUninitializedFootLockStates,
} from "../buffers/footLock";
import { fromYaw, mul, rotate, type Vec3 } from "../lib/math/quat";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { CAMERA_FOLLOW_SYSTEM_ID } from "./cameraFollow";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "./chainDynamics";

export const FOOT_PLANNER_SYSTEM_ID = "footPlannerSystem";

/**
 * Plant-and-step planner. Each foot stays glued to its current world plant
 * until the hip drifts beyond `footUnplantDistance`, then it swings to a new
 * plant ahead of the body's current position. Only one foot per entity may
 * be swinging at a time, so alternation falls out of the rule rather than a
 * scheduled clock.
 *
 * Per-foot state lives in FootLockBuffer (see that file for shape). This
 * system writes the buffer; FootIKSystem reads it and solves the IK.
 *
 * Locked-foot rule (per user 2026-05-11): in normal surface-run state the
 * planter is the *default* — feet hold position, the body moves under them.
 * The only state that should override the lock is sliding/slipping, which
 * isn't yet exposed by CharacterControllerSystem. When it is, this system
 * should release feet (let them drag along velocity) during `surfaceSlide`.
 *
 * Wall-run extension (future): when the surface normal is non-vertical
 * (e.g. running along a wall), legs should angle out to push off the wall
 * based on the normal, rather than dangle straight down. The IK solver
 * already accepts arbitrary surface samples — the planner just needs to
 * sample along the surface plane instead of straight down from the hip.
 */
export function createFootPlannerSystem(): SystemDescriptor {
  return {
    id: FOOT_PLANNER_SYSTEM_ID,
    description:
      "Per-foot plant-and-step planner. Feet remain locked to a world position until the hip drifts beyond a profile-driven distance, then swing (one at a time) to a new plant ahead of the hip. Reads transform/velocity/surface; writes FootLockBuffer for FootIKSystem to consume.",
    buffers: [
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: VELOCITY_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SKELETON_BUFFER_ID, access: "read" },
      { id: FOOT_LOCK_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      SURFACE_CONSTRAINT_SYSTEM_ID,
      CAMERA_FOLLOW_SYSTEM_ID,
      CHAIN_DYNAMICS_SYSTEM_ID,
    ],
    execute: ({ buffer, dt }) => {
      const rigs = readBuffer(buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID));
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const vels = readBuffer(buffer<VelocityBufferData>(VELOCITY_BUFFER_ID));
      const surfaceProv = readBuffer(buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const skel = readBuffer(buffer<SkeletonBufferData>(SKELETON_BUFFER_ID));
      const lockBuf = buffer<FootLockBufferData>(FOOT_LOCK_BUFFER_ID);
      const surface = surfaceProv.heightmap;
      if (!surface) return;

      writeBuffer(lockBuf, (locks) => {
        for (const [id, ctrl] of cc.byEntity) {
          if (ctrl.locomotionMode !== "surfaceConstrained") continue;
          const comp = skel.byEntity.get(id);
          if (!comp) continue;
          const rig = rigs.byId.get(comp.rigId);
          if (!rig || rig.legs.length === 0) continue;
          const t = transforms.byEntity.get(id);
          if (!t) continue;
          const profile = profiles.byId.get(ctrl.profileId);
          if (!profile) continue;

          let footStates = locks.byEntity.get(id);
          if (!footStates || footStates.length !== rig.legs.length) {
            footStates = makeUninitializedFootLockStates(rig.legs.length);
            locks.byEntity.set(id, footStates);
          }

          // Pelvis frame including chain-dynamics lean — same composition the IK uses.
          const yawQ = fromYaw(t.yaw);
          const pelvisLocalRot = comp.bones[0].localRot;
          const pelvisWorldRot = mul(yawQ, pelvisLocalRot);
          const pelvisWorldPos: Vec3 = [t.position[0], t.position[1], t.position[2]];

          const v = vels.byEntity.get(id);
          const vx = v ? v.linear[0] : 0;
          const vz = v ? v.linear[2] : 0;
          const speed = Math.hypot(vx, vz);

          // Forward lead pushes plant targets ahead of the hip so the body can
          // stride over them. At rest the lead is zero, so plant targets land
          // exactly under the hip (foot moves under for balance).
          const lead = speed > profile.footStandingSpeed ? profile.footPlantLeadTime : 0;
          const leadX = vx * lead;
          const leadZ = vz * lead;

          for (let i = 0; i < rig.legs.length; i++) {
            const leg = rig.legs[i];
            const lock = footStates[i];
            const hipUnder = computeHipUnder(rig, leg, pelvisWorldRot, pelvisWorldPos, leadX, leadZ, surface);
            if (!hipUnder) continue;

            if (!lock.initialized) {
              lock.plantPos = [hipUnder[0], hipUnder[1], hipUnder[2]];
              lock.prevPlant = [hipUnder[0], hipUnder[1], hipUnder[2]];
              lock.plantTarget = [hipUnder[0], hipUnder[1], hipUnder[2]];
              lock.swingT = 0;
              lock.state = "planted";
              lock.initialized = true;
              continue;
            }

            if (lock.state === "planted") {
              const dx = lock.plantPos[0] - hipUnder[0];
              const dz = lock.plantPos[2] - hipUnder[2];
              const horizDist = Math.hypot(dx, dz);
              const driftedFar = horizDist > profile.footUnplantDistance;
              if (driftedFar && !anyOtherSwinging(footStates, i)) {
                lock.state = "swinging";
                lock.swingT = 0;
                lock.swingDur = profile.footSwingDuration + 0.04 * horizDist;
                lock.prevPlant = [lock.plantPos[0], lock.plantPos[1], lock.plantPos[2]];
                lock.plantTarget = [hipUnder[0], hipUnder[1], hipUnder[2]];
              }
              // Planted: plantPos stays at world position.
            } else {
              // Swinging: advance and interpolate plantPos for downstream consumers.
              lock.swingT += dt / Math.max(1e-3, lock.swingDur);
              if (lock.swingT >= 1) {
                lock.swingT = 1;
                lock.plantPos = [lock.plantTarget[0], lock.plantTarget[1], lock.plantTarget[2]];
                lock.state = "planted";
              } else {
                const u = smoothstep(lock.swingT);
                lock.plantPos = [
                  lerp(lock.prevPlant[0], lock.plantTarget[0], u),
                  lerp(lock.prevPlant[1], lock.plantTarget[1], u),
                  lerp(lock.prevPlant[2], lock.plantTarget[2], u),
                ];
              }
            }
          }
        }
      });
    },
  };
}

function anyOtherSwinging(states: FootLockState[], skipIndex: number): boolean {
  for (let i = 0; i < states.length; i++) {
    if (i === skipIndex) continue;
    if (states[i].state === "swinging") return true;
  }
  return false;
}

/** World position of the surface point directly below the hip (with optional forward lead). Returns null if outside the heightmap. */
function computeHipUnder(
  rig: { bones: { bindLocalPos: [number, number, number] }[] },
  leg: LegSpec,
  pelvisWorldRot: [number, number, number, number],
  pelvisWorldPos: Vec3,
  leadX: number,
  leadZ: number,
  surface: NonNullable<SurfaceProviderBufferData["heightmap"]>,
): Vec3 | null {
  const hipBone = rig.bones[leg.hipBone];
  const hipOffsetWorld = rotate(pelvisWorldRot, hipBone.bindLocalPos);
  const xz = [pelvisWorldPos[0] + hipOffsetWorld[0] + leadX, pelvisWorldPos[2] + hipOffsetWorld[2] + leadZ];
  const [u, v] = surface.worldToUV(xz[0], xz[1]);
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const sample = surface.sampleAtUV(u, v);
  // Sit the foot fractionally above the surface along its normal (clearance
  // applied here so IK sees an above-ground target). The IK clamp ensures
  // it can be reached.
  const CLEARANCE = 0.05;
  return [
    sample.position[0] + sample.normal[0] * CLEARANCE,
    sample.position[1] + sample.normal[1] * CLEARANCE,
    sample.position[2] + sample.normal[2] * CLEARANCE,
  ];
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
