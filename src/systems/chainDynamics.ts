import { readBuffer, writeBuffer } from "../runtime/buffer";
import { assertDev } from "../runtime/dev";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import {
  RIG_DEFINITION_BUFFER_ID,
  type RigDefinitionBufferData,
  type ChainSpec,
} from "../buffers/rigDefinition";
import {
  SKELETON_BUFFER_ID,
  type SkeletonBufferData,
  type BoneState,
} from "../buffers/skeleton";
import { fromRotationVector, fromYaw, rotate } from "../lib/math/quat";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { SKELETON_WORLD_SYSTEM_ID } from "./skeletonWorld";

export const CHAIN_DYNAMICS_SYSTEM_ID = "chainDynamicsSystem";

/**
 * Wolfire-style procedural lean. For each entity skeleton and each chain
 * declared by the rig (spine, tail, neck, ...), spring-damp the chain's
 * segments toward a target lean derived from horizontal velocity.
 *
 * Why velocity-driven rather than accel-driven: at steady-state run the upper
 * body is biased forward (real runners do this). The spring's lag against
 * velocity changes naturally produces transient accel response too — when you
 * start running, the spine takes ~0.2s to swing forward; when you stop, it
 * overshoots backward briefly. We get both behaviors from one signal.
 *
 * Why generic over `rig.chains` instead of a hardcoded spine path: quadrupeds
 * declare a tail chain, snakes one long chain, no system code changes — the
 * data on the rig is the seam.
 *
 * Why per-bone state in `leanVec`/`leanVel` (rotation-vector form): spring
 * integrators are linear and small offsets stay linear in axis-angle space.
 * `localRot` is the rendering form, re-derived from `leanVec` each tick.
 */
export function createChainDynamicsSystem(): SystemDescriptor {
  return {
    id: CHAIN_DYNAMICS_SYSTEM_ID,
    description:
      "Spring-damped chain lean (Wolfire-style). For each rig.chains entry, distributes a velocity-driven target lean across the chain segments and integrates per-bone leanVec/leanVel; writes derived localRot. Generic across spine/tail/neck/quadruped chains.",
    buffers: [
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: VELOCITY_BUFFER_ID, access: "read" },
      { id: SKELETON_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID],
    // SkeletonWorldSystem also writes Skeleton (worldPos/worldRot fields). We
    // touch leanVec/leanVel/localRot first; FK then composes worldPos from our
    // new localRot. The hazard checker enforces a write/write edge between us.
    runsBefore: [SKELETON_WORLD_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const rigs = readBuffer(buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID));
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const vels = readBuffer(buffer<VelocityBufferData>(VELOCITY_BUFFER_ID));
      const skelBuf = buffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
      const skel = readBuffer(skelBuf);
      if (skel.byEntity.size === 0) return;

      writeBuffer(skelBuf, (d) => {
        for (const [id, comp] of d.byEntity) {
          const rig = rigs.byId.get(comp.rigId);
          if (!rig || rig.chains.length === 0) continue;
          const t = transforms.byEntity.get(id);
          const v = vels.byEntity.get(id);
          if (!t || !v) continue;

          // Horizontal velocity and acceleration in pelvis-local frame.
          // Acceleration is derived from this tick's velocity delta — captures
          // both force-driven changes and surface-constraint adjustments
          // without polluting the physics layer.
          const invYaw = fromYaw(-t.yaw);
          const localVel = rotate(invYaw, [v.linear[0], 0, v.linear[2]]);
          const invDt = dt > 0 ? 1 / dt : 0;
          const worldAccel: [number, number, number] = [
            (v.linear[0] - v.prevLinear[0]) * invDt,
            0,
            (v.linear[2] - v.prevLinear[2]) * invDt,
          ];
          const localAccel = rotate(invYaw, worldAccel);

          for (const chain of rig.chains) {
            applyChain(chain, comp.bones, localVel, localAccel, dt);
          }
        }
      });
    },
  };
}

/**
 * Per-chain spring integrator. Lean target combines velocity (steady-state
 * bias) and acceleration (transient inverted-pendulum response); the total is
 * divided evenly across the chain's `segments`. With pelvis included in
 * segments, the head's *cumulative* world tilt at steady state = N × per-seg
 * = total — so the rig tilts as one piece while the top has the most absolute
 * tilt (graduated chain composition).
 */
function applyChain(
  chain: ChainSpec,
  bones: BoneState[],
  localVel: [number, number, number],
  localAccel: [number, number, number],
  dt: number,
): void {
  const N = chain.segments.length;
  if (N === 0) return;

  // Pelvis-local: +X is right, +Z is backward (forward is -Z). Forward motion
  // (localVel.z < 0) should tilt the chain forward, which is rotation about +X
  // by a *negative* angle (moves +Y toward -Z). Forward acceleration adds to
  // the same direction. Rightward motion (localVel.x > 0) tilts right, which
  // is rotation about +Z by a *negative* angle (moves +Y toward +X).
  const rawX = chain.leanScaleVel * localVel[2] + chain.leanScaleAccel * localAccel[2];
  const rawZ = -chain.leanScaleVel * localVel[0] - chain.leanScaleAccel * localAccel[0];

  // Clamp total magnitude to maxLean.
  const mag = Math.hypot(rawX, rawZ);
  const scale = mag > chain.maxLean && mag > 0 ? chain.maxLean / mag : 1;
  const totalLeanX = rawX * scale;
  const totalLeanZ = rawZ * scale;

  const perSegX = totalLeanX / N;
  const perSegZ = totalLeanZ / N;

  for (const boneIdx of chain.segments) {
    assertDev(
      boneIdx >= 0 && boneIdx < bones.length,
      `chain segment bone index ${boneIdx} out of range [0, ${bones.length})`,
    );
    const b = bones[boneIdx];

    // Critical-damped spring per axis: accel = k*(target - cur) - c*vel.
    const ax = chain.stiffness * (perSegX - b.leanVec[0]) - chain.damping * b.leanVel[0];
    const az = chain.stiffness * (perSegZ - b.leanVec[2]) - chain.damping * b.leanVel[2];

    b.leanVel[0] += ax * dt;
    b.leanVel[2] += az * dt;
    b.leanVec[0] += b.leanVel[0] * dt;
    b.leanVec[2] += b.leanVel[2] * dt;
    // leanVec[1] (yaw twist) intentionally unused in v1 — yaw twist needs a
    // separate signal (e.g. turn rate or counter-rotation for arm swing) and
    // is a Phase 1B+ extension.

    const q = fromRotationVector(b.leanVec);
    b.localRot[0] = q[0];
    b.localRot[1] = q[1];
    b.localRot[2] = q[2];
    b.localRot[3] = q[3];
  }
}
