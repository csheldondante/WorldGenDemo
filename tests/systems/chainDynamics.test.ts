import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  createRigDefinitionBuffer,
  RIG_DEFINITION_BUFFER_ID,
  type RigDefinitionBufferData,
  type RigDefinition,
} from "../../src/buffers/rigDefinition";
import {
  createSkeletonBuffer,
  SKELETON_BUFFER_ID,
  type SkeletonBufferData,
  initSkeletonFromRig,
} from "../../src/buffers/skeleton";
import {
  createTransformBuffer,
  TRANSFORM_BUFFER_ID,
  type TransformBufferData,
} from "../../src/buffers/transform";
import {
  createVelocityBuffer,
  VELOCITY_BUFFER_ID,
  type VelocityBufferData,
} from "../../src/buffers/velocity";
import {
  createCharacterControllerBuffer,
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../../src/buffers/characterController";
import {
  createCharacterControllerProfileBuffer,
  DEFAULT_PLAYER_PROFILE,
} from "../../src/buffers/characterControllerProfile";
import {
  createChainDynamicsSystem,
  CHAIN_DYNAMICS_SYSTEM_ID,
} from "../../src/systems/chainDynamics";

// 4-segment spine chain including pelvis (index 0). Matches the production biped.
const SPINE_RIG: RigDefinition = {
  id: "spineOnly",
  bones: [
    { name: "pelvis", parent: -1, bindLocalPos: [0, 0, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "spine1", parent:  0, bindLocalPos: [0, 0.3, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "spine2", parent:  1, bindLocalPos: [0, 0.3, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "head",   parent:  2, bindLocalPos: [0, 0.3, 0], bindLocalRot: [0, 0, 0, 1] },
  ],
  slots: { pelvis: 0 },
  chains: [
    {
      name: "spine",
      rootBone: 0,
      segments: [0, 1, 2, 3],
      stiffness: 80,
      damping: 18,
      leanScaleVel: 0.03,
      leanScaleAccel: 0.05,
      maxLean: 0.6,
    },
  ],
  legs: [],
};

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createRigDefinitionBuffer());
  reg.registerBuffer(createSkeletonBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerBuffer(createVelocityBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerBuffer(createCharacterControllerProfileBuffer());
  reg.registerSystem(createChainDynamicsSystem());

  const rigBuf = reg.getBuffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID);
  writeBuffer(rigBuf, (d) => { d.byId.set(SPINE_RIG.id, SPINE_RIG); });

  const skel = reg.getBuffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
  const tf = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  const vel = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);

  writeBuffer(skel, (d) => { d.byEntity.set(1, initSkeletonFromRig(SPINE_RIG)); });
  writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: 0, scale: 1 }); });
  writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, 0], prevLinear: [0, 0, 0] }); });
  writeBuffer(cc, (d) => {
    d.byEntity.set(1, {
      state: "surfaceRun",
      locomotionMode: "surfaceConstrained",
      profileId: DEFAULT_PLAYER_PROFILE.id,
      lastTransitionReason: "spawn",
      transitions: [],
      timeInState: 0,
      yawVel: 0,
      targetYaw: 0,
      bodyUpCurrent: [0, 0, 0, 1],
      bodyUpWorld: [0, 1, 0],
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      desiredFacingTangent: [0, 0, -1],
      jumpHolding: false,
      jumpDir: [0, 0, 0],
      jumpImpulseMagMax: 0,
      jumpImpulseApplied: 0,
    });
  });

  const g = buildExecutionGraph({
    id: "g",
    nodes: [CHAIN_DYNAMICS_SYSTEM_ID],
    registry: reg,
  });
  return { reg, g, skel, tf, vel, cc };
}

/** Set steady-state velocity (prev == current so derived accel = 0). */
function setSteadyVelocity(
  vel: ReturnType<typeof setup>["vel"],
  v: [number, number, number],
) {
  writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: v, prevLinear: v }); });
}

function tickN(
  reg: ReturnType<typeof createRegistry>,
  g: ReturnType<typeof buildExecutionGraph>,
  count: number,
  dt = 0.016,
) {
  for (let i = 0; i < count; i++) executeGraph(g, reg, { dt, now: i * dt });
}

describe("ChainDynamicsSystem", () => {
  it("zero velocity and zero accel → no lean accumulates anywhere", () => {
    const { reg, g, skel } = setup();
    tickN(reg, g, 30);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    for (const b of bones) {
      expect(Math.hypot(...b.leanVec)).toBeLessThan(1e-6);
      expect(Math.hypot(...b.leanVel)).toBeLessThan(1e-6);
    }
  });

  it("forward velocity leans the whole rig forward (including pelvis)", () => {
    const { reg, g, skel, vel } = setup();
    setSteadyVelocity(vel, [0, 0, -8]);
    tickN(reg, g, 90); // ~1.4s, several settling time constants
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    // All four segments share the lean — pelvis included.
    for (const i of [0, 1, 2, 3]) {
      expect(bones[i].leanVec[0]).toBeLessThan(-0.01);
    }
    // Steady-state: total = leanScaleVel * 8 = 0.24 distributed across 4 → 0.06 per bone.
    const total = bones[0].leanVec[0] + bones[1].leanVec[0] + bones[2].leanVec[0] + bones[3].leanVec[0];
    expect(total).toBeCloseTo(-0.24, 2);
  });

  it("acceleration produces lean even with zero current velocity (transient response)", () => {
    const { reg, g, skel, vel } = setup();
    // Persistent +5 m/s² forward accel over dt: velocity stays small but accel signal is large.
    // Simulate by setting prevLinear behind linear each tick.
    const dt = 0.016;
    writeBuffer(vel, (d) => {
      d.byEntity.set(1, {
        linear: [0, 0, -dt * 5],     // tiny velocity
        prevLinear: [0, 0, 0],        // accel = -5 m/s² along Z (= forward)
      });
    });
    // Single tick to see the spring start integrating toward the accel-driven target.
    executeGraph(g, reg, { dt, now: 0 });
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    expect(bones[0].leanVec[0]).toBeLessThan(0);
    expect(bones[1].leanVec[0]).toBeLessThan(0);
  });

  it("side velocity (+X right) leans the rig to the right", () => {
    const { reg, g, skel, vel } = setup();
    setSteadyVelocity(vel, [5, 0, 0]);
    tickN(reg, g, 90);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    for (const i of [0, 1, 2, 3]) {
      expect(bones[i].leanVec[2]).toBeLessThan(-0.005);
      expect(Math.abs(bones[i].leanVec[0])).toBeLessThan(0.005);
    }
  });

  it("respects yaw: world velocity is re-expressed in pelvis-local frame", () => {
    const { reg, g, skel, vel, tf } = setup();
    writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: Math.PI / 2, scale: 1 }); });
    // Three.js convention: yaw=π/2 makes character face -X; (-8, 0, 0) is then forward.
    setSteadyVelocity(vel, [-8, 0, 0]);
    tickN(reg, g, 90);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    expect(bones[1].leanVec[0]).toBeLessThan(-0.01);
    expect(Math.abs(bones[1].leanVec[2])).toBeLessThan(0.01);
  });

  it("clamps to maxLean for extreme inputs", () => {
    const { reg, g, skel, vel } = setup();
    setSteadyVelocity(vel, [0, 0, -1000]);
    tickN(reg, g, 90);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    const total = Math.abs(bones[0].leanVec[0] + bones[1].leanVec[0] + bones[2].leanVec[0] + bones[3].leanVec[0]);
    expect(total).toBeLessThanOrEqual(0.6 + 1e-3);
  });

  it.skip("airborne (volumeConstrained) + forward speed → extra forward pitch on the chain", () => {
    const { reg, g, skel, vel, cc } = setup();
    setSteadyVelocity(vel, [0, 0, -8]); // running forward at full speed
    writeBuffer(cc, (d) => {
      const c = d.byEntity.get(1)!;
      c.locomotionMode = "volumeConstrained";
      d.byEntity.set(1, c);
    });
    tickN(reg, g, 90);
    const groundedReg = setup();
    setSteadyVelocity(groundedReg.vel, [0, 0, -8]);
    tickN(groundedReg.reg, groundedReg.g, 90);
    const airBones = readBuffer(skel).byEntity.get(1)!.bones;
    const groundBones = readBuffer(groundedReg.skel).byEntity.get(1)!.bones;
    // Airborne should pitch further forward (more negative on the +X-axis
    // rotation component) than grounded at the same velocity.
    const airTotal = airBones[0].leanVec[0] + airBones[1].leanVec[0] + airBones[2].leanVec[0] + airBones[3].leanVec[0];
    const groundTotal = groundBones[0].leanVec[0] + groundBones[1].leanVec[0] + groundBones[2].leanVec[0] + groundBones[3].leanVec[0];
    expect(airTotal).toBeLessThan(groundTotal);
  });

  it.skip("speed-driven hip drop: pelvis Y lowers as speed rises; restores at idle", () => {
    const { reg, g, skel, vel } = setup();
    // At rest: pelvis localPos.Y should equal bind (0 in SPINE_RIG).
    tickN(reg, g, 2);
    const restY = readBuffer(skel).byEntity.get(1)!.bones[0].localPos[1];
    expect(restY).toBeCloseTo(0, 6);

    // At full run: pelvis drops by hipDropAtFullSpeed (0.18 m).
    setSteadyVelocity(vel, [0, 0, -8]); // matches DEFAULT_PLAYER_PROFILE.desiredRunSpeed
    tickN(reg, g, 2);
    const runY = readBuffer(skel).byEntity.get(1)!.bones[0].localPos[1];
    expect(runY).toBeLessThan(-0.17);
    expect(runY).toBeGreaterThan(-0.19);

    // Decelerating to idle ramps pelvis back to bind.
    setSteadyVelocity(vel, [0, 0, 0]);
    tickN(reg, g, 2);
    const stoppedY = readBuffer(skel).byEntity.get(1)!.bones[0].localPos[1];
    expect(stoppedY).toBeCloseTo(0, 6);
  });

  it("airborne with zero speed → no extra pitch contribution (speed-scaled)", () => {
    const { reg, g, skel, cc } = setup();
    writeBuffer(cc, (d) => {
      const c = d.byEntity.get(1)!;
      c.locomotionMode = "volumeConstrained";
      d.byEntity.set(1, c);
    });
    tickN(reg, g, 30);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    for (const b of bones) {
      expect(Math.hypot(...b.leanVec)).toBeLessThan(1e-6);
    }
  });

  it("writes a normalized localRot quaternion derived from leanVec", () => {
    const { reg, g, skel, vel } = setup();
    setSteadyVelocity(vel, [0, 0, -8]);
    tickN(reg, g, 90);
    const bone = readBuffer(skel).byEntity.get(1)!.bones[1];
    const mag = Math.hypot(bone.localRot[0], bone.localRot[1], bone.localRot[2], bone.localRot[3]);
    expect(Math.abs(mag - 1)).toBeLessThan(1e-6);
    expect(bone.localRot[0]).toBeLessThan(0);
  });
});
