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
  createChainDynamicsSystem,
  CHAIN_DYNAMICS_SYSTEM_ID,
} from "../../src/systems/chainDynamics";

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
    { name: "spine", rootBone: 0, segments: [1, 2, 3], stiffness: 80, damping: 18, leanScale: 0.04, maxLean: 0.5 },
  ],
};

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createRigDefinitionBuffer());
  reg.registerBuffer(createSkeletonBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerBuffer(createVelocityBuffer());
  reg.registerSystem(createChainDynamicsSystem());

  const rigBuf = reg.getBuffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID);
  writeBuffer(rigBuf, (d) => { d.byId.set(SPINE_RIG.id, SPINE_RIG); });

  const skel = reg.getBuffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
  const tf = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  const vel = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);

  writeBuffer(skel, (d) => { d.byEntity.set(1, initSkeletonFromRig(SPINE_RIG)); });
  writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: 0, scale: 1 }); });
  writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, 0] }); });

  const g = buildExecutionGraph({
    id: "g",
    nodes: [CHAIN_DYNAMICS_SYSTEM_ID],
    registry: reg,
  });
  return { reg, g, skel, tf, vel };
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
  it("zero velocity → no lean accumulates, segments stay at bind pose", () => {
    const { reg, g, skel } = setup();
    tickN(reg, g, 30);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    for (const i of [1, 2, 3]) {
      expect(Math.hypot(...bones[i].leanVec)).toBeLessThan(1e-6);
      expect(Math.hypot(...bones[i].leanVel)).toBeLessThan(1e-6);
    }
  });

  it("forward velocity (-Z) makes the chain lean forward (rotation about +X is negative)", () => {
    const { reg, g, skel, vel } = setup();
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, -8] }); });
    tickN(reg, g, 60); // settle (~1s)
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    // Each segment should have a negative X-axis rotation component (forward lean).
    for (const i of [1, 2, 3]) {
      expect(bones[i].leanVec[0]).toBeLessThan(-0.01);
      expect(Math.abs(bones[i].leanVec[2])).toBeLessThan(0.005);
    }
    // Total accumulated lean should match leanScale × vel / segments.
    const total = bones[1].leanVec[0] + bones[2].leanVec[0] + bones[3].leanVec[0];
    // leanScale (0.04) × localVel.z (-8) = -0.32, distributed → sum ≈ -0.32.
    expect(total).toBeCloseTo(-0.32, 2);
  });

  it("rightward velocity (+X) leans the chain to the right (rotation about +Z is negative)", () => {
    const { reg, g, skel, vel } = setup();
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [5, 0, 0] }); });
    tickN(reg, g, 60);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    for (const i of [1, 2, 3]) {
      expect(bones[i].leanVec[2]).toBeLessThan(-0.005);
      expect(Math.abs(bones[i].leanVec[0])).toBeLessThan(0.005);
    }
  });

  it("respects yaw: rotating the entity 90° re-orients velocity into pelvis-local frame", () => {
    const { reg, g, skel, vel, tf } = setup();
    // Three.js convention: yaw=π/2 rotates the character's forward direction
    // from -Z to -X. So world velocity (-8, 0, 0) is forward in pelvis-local.
    writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: Math.PI / 2, scale: 1 }); });
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [-8, 0, 0] }); });
    tickN(reg, g, 60);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    // Should look like forward-lean in local frame (negative X-axis rotation), not side lean.
    expect(bones[1].leanVec[0]).toBeLessThan(-0.01);
    expect(Math.abs(bones[1].leanVec[2])).toBeLessThan(0.01);
  });

  it("clamps to maxLean for extreme velocities", () => {
    const { reg, g, skel, vel } = setup();
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, -1000] }); }); // absurd speed
    tickN(reg, g, 60);
    const bones = readBuffer(skel).byEntity.get(1)!.bones;
    const total = Math.abs(bones[1].leanVec[0] + bones[2].leanVec[0] + bones[3].leanVec[0]);
    // maxLean (0.5) should bound the total magnitude.
    expect(total).toBeLessThanOrEqual(0.5 + 1e-3);
  });

  it("writes a derived localRot quaternion from leanVec", () => {
    const { reg, g, skel, vel } = setup();
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, -8] }); });
    tickN(reg, g, 60);
    const bone = readBuffer(skel).byEntity.get(1)!.bones[1];
    // Quaternion should be normalized (|q| ≈ 1).
    const mag = Math.hypot(bone.localRot[0], bone.localRot[1], bone.localRot[2], bone.localRot[3]);
    expect(Math.abs(mag - 1)).toBeLessThan(1e-6);
    // For a forward lean (negative X-axis rotation) the X component should be negative.
    expect(bone.localRot[0]).toBeLessThan(0);
  });
});
