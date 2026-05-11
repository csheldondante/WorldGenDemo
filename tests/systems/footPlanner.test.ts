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
  createFootLockBuffer,
  FOOT_LOCK_BUFFER_ID,
  type FootLockBufferData,
} from "../../src/buffers/footLock";
import {
  createSurfaceProviderBuffer,
  SURFACE_PROVIDER_BUFFER_ID,
  type SurfaceProviderBufferData,
} from "../../src/buffers/surfaceProvider";
import { createFootPlannerSystem, FOOT_PLANNER_SYSTEM_ID } from "../../src/systems/footPlanner";
import type { SurfaceProvider, SurfaceSample } from "../../src/world/surfaceProvider";

// Flat infinite-extent surface at y=0, normal +Y, friction 1.
const FLAT_SURFACE: SurfaceProvider = {
  id: "flat",
  sampleAtUV(): SurfaceSample {
    return {
      position: [0, 0, 0],
      normal: [0, 1, 0],
      tangentU: [1, 0, 0],
      tangentV: [0, 0, 1],
      slopeRad: 0,
      friction: 1,
      normalInMax: 800,
      normalOutMax: 200,
      traversable: true,
    };
  },
  worldToUV(_x: number, _z: number): [number, number] { return [0.5, 0.5]; },
  uvToWorld(_u: number, _v: number): [number, number, number] { return [0, 0, 0]; },
  canAttachAt(): boolean { return true; },
  sampleVelocityAt(): [number, number, number] { return [0, 0, 0]; },
};

// Position-aware surface: returns the actual sampled XZ so the planner can
// detect hip drift in world units.
const POSITION_AWARE_SURFACE: SurfaceProvider = {
  id: "flat-aware",
  sampleAtUV(u: number, v: number): SurfaceSample {
    // Map UV linearly to a 100×100 box centered at origin (matches worldToUV below).
    const x = (u - 0.5) * 100;
    const z = (v - 0.5) * 100;
    return {
      position: [x, 0, z],
      normal: [0, 1, 0],
      tangentU: [1, 0, 0],
      tangentV: [0, 0, 1],
      slopeRad: 0,
      friction: 1,
      normalInMax: 800,
      normalOutMax: 200,
      traversable: true,
    };
  },
  worldToUV(x: number, z: number): [number, number] {
    return [x / 100 + 0.5, z / 100 + 0.5];
  },
  uvToWorld(u: number, v: number): [number, number, number] {
    return [(u - 0.5) * 100, 0, (v - 0.5) * 100];
  },
  canAttachAt(u: number, v: number): boolean { return u >= 0 && u <= 1 && v >= 0 && v <= 1; },
  sampleVelocityAt(): [number, number, number] { return [0, 0, 0]; },
};

const TWO_LEG_RIG: RigDefinition = {
  id: "twoLeg",
  bones: [
    { name: "pelvis",    parent: -1, bindLocalPos: [0, 1, 0],     bindLocalRot: [0, 0, 0, 1] },
    { name: "spine",     parent:  0, bindLocalPos: [0, 0.3, 0],   bindLocalRot: [0, 0, 0, 1] },
    { name: "head",      parent:  1, bindLocalPos: [0, 0.3, 0],   bindLocalRot: [0, 0, 0, 1] },
    { name: "upperLegL", parent:  0, bindLocalPos: [ 0.1, 0, 0],  bindLocalRot: [0, 0, 0, 1] },
    { name: "lowerLegL", parent:  3, bindLocalPos: [0, -0.4, 0],  bindLocalRot: [0, 0, 0, 1] },
    { name: "footL",     parent:  4, bindLocalPos: [0, -0.4, 0],  bindLocalRot: [0, 0, 0, 1] },
    { name: "upperLegR", parent:  0, bindLocalPos: [-0.1, 0, 0],  bindLocalRot: [0, 0, 0, 1] },
    { name: "lowerLegR", parent:  6, bindLocalPos: [0, -0.4, 0],  bindLocalRot: [0, 0, 0, 1] },
    { name: "footR",     parent:  7, bindLocalPos: [0, -0.4, 0],  bindLocalRot: [0, 0, 0, 1] },
  ],
  slots: {},
  chains: [],
  legs: [
    { name: "legL", hipBone: 3, kneeBone: 4, footBone: 5, kneePoleDir: [0, 0, -1] },
    { name: "legR", hipBone: 6, kneeBone: 7, footBone: 8, kneePoleDir: [0, 0, -1] },
  ],
};

function setup(surface: SurfaceProvider = POSITION_AWARE_SURFACE) {
  const reg = createRegistry();
  reg.registerBuffer(createRigDefinitionBuffer());
  reg.registerBuffer(createSkeletonBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerBuffer(createVelocityBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerBuffer(createCharacterControllerProfileBuffer());
  reg.registerBuffer(createFootLockBuffer());
  reg.registerBuffer(createSurfaceProviderBuffer());
  reg.registerSystem(createFootPlannerSystem());

  const rigBuf = reg.getBuffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID);
  writeBuffer(rigBuf, (d) => { d.byId.set(TWO_LEG_RIG.id, TWO_LEG_RIG); });

  const sp = reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID);
  writeBuffer(sp, (d) => { d.heightmap = surface; });

  const skel = reg.getBuffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
  const tf = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  const vel = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
  const locks = reg.getBuffer<FootLockBufferData>(FOOT_LOCK_BUFFER_ID);

  writeBuffer(skel, (d) => { d.byEntity.set(1, initSkeletonFromRig(TWO_LEG_RIG)); });
  writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 1, 0], yaw: 0, scale: 1 }); });
  writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, 0], prevLinear: [0, 0, 0] }); });
  writeBuffer(cc, (d) => {
    d.byEntity.set(1, {
      state: "surfaceRun",
      locomotionMode: "surfaceConstrained",
      profileId: DEFAULT_PLAYER_PROFILE.id,
      lastTransitionReason: "spawn",
      timeInState: 0,
      yawVel: 0,
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
    });
  });

  const g = buildExecutionGraph({ id: "g", nodes: [FOOT_PLANNER_SYSTEM_ID], registry: reg });
  return { reg, g, skel, tf, vel, cc, locks };
}

function tick(
  reg: ReturnType<typeof createRegistry>,
  g: ReturnType<typeof buildExecutionGraph>,
  dt = 0.016,
) {
  executeGraph(g, reg, { dt, now: 0 });
}

describe("FootPlannerSystem", () => {
  it("initializes each foot to its hip-under position on first tick", () => {
    const { reg, g, locks } = setup();
    tick(reg, g);
    const states = readBuffer(locks).byEntity.get(1)!;
    expect(states).toHaveLength(2);
    expect(states[0].initialized).toBe(true);
    expect(states[1].initialized).toBe(true);
    expect(states[0].state).toBe("planted");
    expect(states[1].state).toBe("planted");
  });

  it("keeps feet planted at world position when the character is stationary", () => {
    const { reg, g, locks } = setup();
    tick(reg, g);
    const initialPlant = [...readBuffer(locks).byEntity.get(1)![0].plantPos];
    for (let i = 0; i < 30; i++) tick(reg, g);
    const finalPlant = readBuffer(locks).byEntity.get(1)![0].plantPos;
    expect(finalPlant[0]).toBe(initialPlant[0]);
    expect(finalPlant[2]).toBe(initialPlant[2]);
  });

  it("starts a swing when the hip drifts more than footUnplantDistance from a planted foot", () => {
    const { reg, g, tf, locks } = setup();
    tick(reg, g); // initialize
    // Drift the entity 1 meter forward; that's beyond the 0.35m default.
    writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 1, -1.0], yaw: 0, scale: 1 }); });
    tick(reg, g);
    const states = readBuffer(locks).byEntity.get(1)!;
    const anySwinging = states.some((s) => s.state === "swinging");
    expect(anySwinging).toBe(true);
  });

  it("alternates: only one foot swings at a time", () => {
    const { reg, g, tf, locks } = setup();
    tick(reg, g);
    writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 1, -2.0], yaw: 0, scale: 1 }); });
    tick(reg, g);
    let states = readBuffer(locks).byEntity.get(1)!;
    const swinging = states.filter((s) => s.state === "swinging").length;
    expect(swinging).toBeLessThanOrEqual(1);
    // Push the entity even farther; complete the first swing across many ticks.
    writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 1, -5.0], yaw: 0, scale: 1 }); });
    for (let i = 0; i < 60; i++) tick(reg, g, 0.016);
    states = readBuffer(locks).byEntity.get(1)!;
    const stillSwinging = states.filter((s) => s.state === "swinging").length;
    expect(stillSwinging).toBeLessThanOrEqual(1);
  });

  it("after enough ticks the trailing foot completes its swing and is planted near hipUnder", () => {
    const { reg, g, tf, locks } = setup();
    tick(reg, g);
    // Place the character 1m forward and run several ticks to allow one swing
    // to complete.
    writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 1, -1.0], yaw: 0, scale: 1 }); });
    for (let i = 0; i < 30; i++) tick(reg, g, 0.016);
    const states = readBuffer(locks).byEntity.get(1)!;
    // At least one foot's plant should now be at the new world position.
    const closeToNew = states.some((s) => Math.abs(s.plantPos[2] + 1) < 0.4);
    expect(closeToNew).toBe(true);
  });

  it("skips entities not in surfaceConstrained locomotion mode", () => {
    const { reg, g, cc, locks } = setup();
    writeBuffer(cc, (d) => {
      const c = d.byEntity.get(1)!;
      c.locomotionMode = "volumeConstrained";
      d.byEntity.set(1, c);
    });
    tick(reg, g);
    expect(readBuffer(locks).byEntity.has(1)).toBe(false);
  });

  it("body yaw drift past threshold triggers a step even without translation", () => {
    const { reg, g, tf, locks } = setup();
    tick(reg, g); // initialize
    // Rotate the body in place by ~30° (default threshold 0.35 rad ≈ 20°).
    writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 1, 0], yaw: 0.52, scale: 1 }); });
    tick(reg, g);
    const states = readBuffer(locks).byEntity.get(1)!;
    const anySwinging = states.some((s) => s.state === "swinging");
    expect(anySwinging).toBe(true);
  });

  it("predicts plant target ahead of body during forward run", () => {
    const { reg, g, tf, vel, locks } = setup();
    tick(reg, g); // initialize plants under the hip at z=0
    // Move entity forward to trigger a swing, then check plantTarget is ahead of CURRENT hip.
    writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 1, -1.0], yaw: 0, scale: 1 }); });
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, -8], prevLinear: [0, 0, -8] }); });
    tick(reg, g);
    const swinging = readBuffer(locks).byEntity.get(1)!.find((s) => s.state === "swinging");
    expect(swinging).toBeDefined();
    if (!swinging) return;
    // plantTarget.z should be ahead of body (more negative than entity's current z = -1.0)
    // by at least velocity * (swingDur + leadTime).
    expect(swinging.plantTarget[2]).toBeLessThan(-1.0 - 0.5);
  });

  it("flat surface (no-op worldToUV) still initializes feet to surface y=0", () => {
    const { reg, g, locks } = setup(FLAT_SURFACE);
    tick(reg, g);
    const states = readBuffer(locks).byEntity.get(1)!;
    expect(states[0].plantPos[1]).toBeCloseTo(0.05, 4); // surface y + clearance
  });
});
