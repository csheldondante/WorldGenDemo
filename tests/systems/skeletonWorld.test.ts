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
  createSkeletonWorldSystem,
  SKELETON_WORLD_SYSTEM_ID,
} from "../../src/systems/skeletonWorld";

function near(a: number, b: number, tol = 1e-5): boolean {
  return Math.abs(a - b) < tol;
}

function setup(rig: RigDefinition) {
  const reg = createRegistry();
  reg.registerBuffer(createRigDefinitionBuffer());
  reg.registerBuffer(createSkeletonBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerSystem(createSkeletonWorldSystem());

  const rigBuf = reg.getBuffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID);
  writeBuffer(rigBuf, (d) => { d.byId.set(rig.id, rig); });

  const g = buildExecutionGraph({
    id: "g",
    nodes: [SKELETON_WORLD_SYSTEM_ID],
    registry: reg,
  });

  const skelBuf = reg.getBuffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
  const tfBuf = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  return { reg, g, skelBuf, tfBuf };
}

const chainRig: RigDefinition = {
  id: "chain3",
  bones: [
    { name: "root", parent: -1, bindLocalPos: [0, 0, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "mid",  parent:  0, bindLocalPos: [0, 1, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "tip",  parent:  1, bindLocalPos: [0, 1, 0], bindLocalRot: [0, 0, 0, 1] },
  ],
  slots: { root: 0, tip: 2 },
  chains: [],
};

describe("SkeletonWorldSystem — forward kinematics", () => {
  it("places each bone in world by stacking local offsets at the entity transform", () => {
    const { reg, g, skelBuf, tfBuf } = setup(chainRig);
    writeBuffer(tfBuf, (d) => { d.byEntity.set(1, { position: [10, 0, 5], yaw: 0, scale: 1 }); });
    writeBuffer(skelBuf, (d) => { d.byEntity.set(1, initSkeletonFromRig(chainRig)); });

    executeGraph(g, reg, { dt: 0.016, now: 0 });

    const bones = readBuffer(skelBuf).byEntity.get(1)!.bones;
    expect(bones[0].worldPos).toEqual([10, 0, 5]);
    expect(bones[1].worldPos[0]).toBeCloseTo(10, 5);
    expect(bones[1].worldPos[1]).toBeCloseTo(1, 5);
    expect(bones[1].worldPos[2]).toBeCloseTo(5, 5);
    expect(bones[2].worldPos[1]).toBeCloseTo(2, 5);
  });

  it("rotates the chain by the entity yaw (90° yaw turns vertical chain along -X)", () => {
    const { reg, g, skelBuf, tfBuf } = setup(chainRig);
    // Build a horizontal rig: bones stack along +Z so yaw rotation has visible effect.
    const zRig: RigDefinition = {
      id: "zchain",
      bones: [
        { name: "root", parent: -1, bindLocalPos: [0, 0, 0], bindLocalRot: [0, 0, 0, 1] },
        { name: "tip",  parent:  0, bindLocalPos: [0, 0, -1], bindLocalRot: [0, 0, 0, 1] },
      ],
      slots: {},
      chains: [],
    };
    const rigBuf = reg.getBuffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID);
    writeBuffer(rigBuf, (d) => { d.byId.set(zRig.id, zRig); });

    writeBuffer(tfBuf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: Math.PI / 2, scale: 1 }); });
    writeBuffer(skelBuf, (d) => { d.byEntity.set(1, initSkeletonFromRig(zRig)); });

    executeGraph(g, reg, { dt: 0.016, now: 0 });

    const tip = readBuffer(skelBuf).byEntity.get(1)!.bones[1];
    // +90° yaw rotates -Z forward into -X.
    expect(near(tip.worldPos[0], -1)).toBe(true);
    expect(near(tip.worldPos[1], 0)).toBe(true);
    expect(near(tip.worldPos[2], 0)).toBe(true);
  });

  it("respects non-identity local rotations on child bones", () => {
    const { reg, g, skelBuf, tfBuf } = setup(chainRig);
    writeBuffer(tfBuf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: 0, scale: 1 }); });
    writeBuffer(skelBuf, (d) => {
      const comp = initSkeletonFromRig(chainRig);
      // Bend mid-bone 90° about +Z so the tip's local +Y offset points along -X
      // in mid's frame, hence the chain bends sideways.
      const sin = Math.sin(Math.PI / 4);
      const cos = Math.cos(Math.PI / 4);
      comp.bones[1].localRot = [0, 0, sin, cos];
      d.byEntity.set(1, comp);
    });

    executeGraph(g, reg, { dt: 0.016, now: 0 });

    const bones = readBuffer(skelBuf).byEntity.get(1)!.bones;
    // After 90° about +Z, the offset (0,1,0) added in mid's frame ends at (-1,1,0).
    expect(near(bones[2].worldPos[0], -1)).toBe(true);
    expect(near(bones[2].worldPos[1], 1)).toBe(true);
    expect(near(bones[2].worldPos[2], 0)).toBe(true);
  });

  it("is a no-op when no entities have skeletons", () => {
    const { reg, g } = setup(chainRig);
    expect(() => executeGraph(g, reg, { dt: 0.016, now: 0 })).not.toThrow();
  });
});
