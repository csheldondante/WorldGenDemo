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
  type CharacterControllerProfile,
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
 * until the hip drifts beyond `footUnplantDistance` OR the body has yawed
 * `footUnplantYawDelta` since the plant — then it swings to a new plant.
 * The yaw trigger is what makes turn-in-place reposition feet; hip-spread on
 * a biped is only ~0.1m so translation drift alone barely fires.
 *
 * Only one foot per entity may be swinging at a time, so alternation falls
 * out of the rule rather than a scheduled clock.
 *
 * Plant target prediction: when a swing starts we look ahead by
 * (swingDuration + footPlantLeadTime) seconds and place the new plant where
 * the hip *will be* at that time, not where it is now. Without this, the
 * body strides past the plant during the swing and feet visibly trail behind.
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
      "Per-foot plant-and-step planner. Feet remain locked to a world position until hip translation or body yaw passes profile thresholds, then swing (one at a time) to a predicted future-hip plant. Reads transform/velocity/surface; writes FootLockBuffer for FootIKSystem to consume.",
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

          // Compose pelvis frame using yaw + chain-dynamics lean — same as IK.
          const yawQ = fromYaw(t.yaw);
          const pelvisLocalRot = comp.bones[0].localRot;
          const pelvisWorldRot = mul(yawQ, pelvisLocalRot);
          const pelvisWorldPos: Vec3 = [t.position[0], t.position[1], t.position[2]];

          const v = vels.byEntity.get(id);
          const vx = v ? v.linear[0] : 0;
          const vz = v ? v.linear[2] : 0;
          const speed = Math.hypot(vx, vz);

          for (let i = 0; i < rig.legs.length; i++) {
            const leg = rig.legs[i];
            const lock = footStates[i];

            const hipOffsetWorld = rotate(pelvisWorldRot, rig.bones[leg.hipBone].bindLocalPos);
            const hipWorldX = pelvisWorldPos[0] + hipOffsetWorld[0];
            const hipWorldY = pelvisWorldPos[1] + hipOffsetWorld[1];
            const hipWorldZ = pelvisWorldPos[2] + hipOffsetWorld[2];
            const currentHipUnder = sampleSurfaceAtXZ(surface, hipWorldX, hipWorldZ);
            if (!currentHipUnder) continue;

            if (!lock.initialized) {
              setPlanted(lock, currentHipUnder, t.yaw);
              lock.initialized = true;
              continue;
            }

            if (lock.state === "planted") {
              const dx = lock.plantPos[0] - currentHipUnder[0];
              const dz = lock.plantPos[2] - currentHipUnder[2];
              const horizDist = Math.hypot(dx, dz);
              const yawDrift = Math.abs(wrapPi(t.yaw - lock.plantYaw));
              const distTrigger = horizDist > profile.footUnplantDistance;
              const yawTrigger = yawDrift > profile.footUnplantYawDelta;

              // Strict alternation: a foot only starts a swing when no other
              // foot is currently swinging. Letting both swing simultaneously
              // makes them visibly both reach forward, which looks worse than
              // a transiently-stilted back leg at sprint speed. The
              // `footMaxReachStretch` profile knob is no longer consulted at
              // the trigger — it's effectively a tuning ceiling on how far
              // behind the back leg can fall, addressed instead by shortening
              // `swingDuration` at speed.
              const trigger = (distTrigger || yawTrigger) && !anyOtherSwinging(footStates, i);
              if (trigger) {
                startSwing(lock, profile, leg, rig.bones[leg.hipBone].bindLocalPos, t.yaw, pelvisWorldPos, vx, vz, speed, horizDist, surface);
              }
              // hipWorldY only used by the over-reach math previously; kept the var
              // to make a future over-reach branch easy to wire back in.
              void hipWorldY;
            } else {
              // Swinging: advance and lerp plantPos for IK consumers.
              lock.swingT += dt / Math.max(1e-3, lock.swingDur);
              if (lock.swingT >= 1) {
                lock.swingT = 1;
                lock.plantPos = [lock.plantTarget[0], lock.plantTarget[1], lock.plantTarget[2]];
                lock.state = "planted";
                lock.plantYaw = t.yaw;
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

function setPlanted(lock: FootLockState, plant: Vec3, yaw: number): void {
  lock.plantPos = [plant[0], plant[1], plant[2]];
  lock.prevPlant = [plant[0], plant[1], plant[2]];
  lock.plantTarget = [plant[0], plant[1], plant[2]];
  lock.swingT = 0;
  lock.state = "planted";
  lock.plantYaw = yaw;
}

/**
 * Start a swing with a predicted plant target.
 *
 * We project the hip forward by (swingDuration + leadTime) along the current
 * velocity, then sample the surface there — so the foot lands ahead of where
 * the hip will be at swing end, not where it is now. Without the lookahead
 * the body strides past the plant during the 0.22s swing and feet visibly
 * trail behind.
 *
 * We don't predict yaw rotation during the swing — a 0.3s swing at typical
 * turn rates rotates the body only ~1.5 rad max, which is acceptable
 * approximation error for the predicted plant. (Yaw drift is what triggered
 * the swing in the first place if turning in place; the new plant lines up
 * with current yaw.)
 */
function startSwing(
  lock: FootLockState,
  profile: CharacterControllerProfile,
  _leg: LegSpec,
  hipBindLocalPos: [number, number, number],
  currentYaw: number,
  pelvisWorldPos: Vec3,
  vx: number,
  vz: number,
  speed: number,
  horizDist: number,
  surface: NonNullable<SurfaceProviderBufferData["heightmap"]>,
): void {
  // Swing duration shortens with speed so sprint cadence stays high enough
  // that the back leg never has time to stretch out behind. Plus a small
  // bump per drift distance so long re-plants take a hair longer.
  const dynBase = profile.footSwingDuration / (1 + profile.footSwingSpeedFactor * speed);
  const swingDur = Math.max(profile.footMinSwingDuration, dynBase) + 0.02 * horizDist;
  const lookahead = swingDur + profile.footPlantLeadTime;

  // Predict where the hip's XZ will be at swing-end + leadBuffer. Yaw held
  // constant for the prediction (good enough; a full yaw chase finishes
  // faster than a typical swing distance).
  const futureBodyX = pelvisWorldPos[0] + vx * lookahead;
  const futureBodyZ = pelvisWorldPos[2] + vz * lookahead;
  // Apply current yaw to the leg's bind offset to get future hip XZ.
  const cy = Math.cos(currentYaw);
  const sy = Math.sin(currentYaw);
  // Body-local (x, y, z) rotated by yaw about +Y → world.
  // x_world = x_local * cos(yaw) + z_local * sin(yaw)
  // z_world = -x_local * sin(yaw) + z_local * cos(yaw)
  const hipDx = hipBindLocalPos[0] * cy + hipBindLocalPos[2] * sy;
  const hipDz = -hipBindLocalPos[0] * sy + hipBindLocalPos[2] * cy;
  const targetX = futureBodyX + hipDx;
  const targetZ = futureBodyZ + hipDz;
  const target = sampleSurfaceAtXZ(surface, targetX, targetZ);
  if (!target) return; // outside map; defer swing decision to next tick

  lock.state = "swinging";
  lock.swingT = 0;
  lock.swingDur = swingDur;
  lock.prevPlant = [lock.plantPos[0], lock.plantPos[1], lock.plantPos[2]];
  lock.plantTarget = [target[0], target[1], target[2]];
}

function sampleSurfaceAtXZ(
  surface: NonNullable<SurfaceProviderBufferData["heightmap"]>,
  x: number,
  z: number,
): Vec3 | null {
  const [u, v] = surface.worldToUV(x, z);
  if (u < 0 || u > 1 || v < 0 || v > 1) return null;
  const sample = surface.sampleAtUV(u, v);
  const CLEARANCE = 0.05;
  return [
    sample.position[0] + sample.normal[0] * CLEARANCE,
    sample.position[1] + sample.normal[1] * CLEARANCE,
    sample.position[2] + sample.normal[2] * CLEARANCE,
  ];
}

function anyOtherSwinging(states: FootLockState[], skipIndex: number): boolean {
  for (let i = 0; i < states.length; i++) {
    if (i === skipIndex) continue;
    if (states[i].state === "swinging") return true;
  }
  return false;
}


function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function wrapPi(x: number): number {
  const TAU = Math.PI * 2;
  let r = x % TAU;
  if (r > Math.PI) r -= TAU;
  else if (r <= -Math.PI) r += TAU;
  return r;
}
