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
  createSurfaceAttachmentBuffer,
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../../src/buffers/surfaceAttachment";
import {
  createVolumeFieldBuffer,
  VOLUME_FIELD_BUFFER_ID,
  type VolumeFieldBufferData,
} from "../../src/buffers/volumeField";
import {
  createBodyLeanSystem,
  BODY_LEAN_SYSTEM_ID,
} from "../../src/systems/bodyLean";

const BIPED: RigDefinition = {
  id: "biped",
  bones: [
    { name: "pelvis",    parent: -1, bindLocalPos: [0,    0.3,  0],    bindLocalRot: [0, 0, 0, 1] },
    { name: "spine1",    parent:  0, bindLocalPos: [0,    0.30, 0],    bindLocalRot: [0, 0, 0, 1] },
    { name: "spine2",    parent:  1, bindLocalPos: [0,    0.30, 0],    bindLocalRot: [0, 0, 0, 1] },
    { name: "head",      parent:  2, bindLocalPos: [0,    0.30, 0],    bindLocalRot: [0, 0, 0, 1] },
    { name: "upperLegL", parent:  0, bindLocalPos: [0.10, 0,    0],    bindLocalRot: [0, 0, 0, 1] },
    { name: "lowerLegL", parent:  4, bindLocalPos: [0,   -0.40, 0],    bindLocalRot: [0, 0, 0, 1] },
    { name: "footL",     parent:  5, bindLocalPos: [0,   -0.40, 0],    bindLocalRot: [0, 0, 0, 1] },
  ],
  slots: {},
  chains: [],
  legs: [
    { name: "legL", hipBone: 4, kneeBone: 5, footBone: 6, kneePoleDir: [0, 0, -1] },
  ],
};

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createRigDefinitionBuffer());
  reg.registerBuffer(createSkeletonBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerBuffer(createVelocityBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerBuffer(createCharacterControllerProfileBuffer());
  reg.registerBuffer(createSurfaceAttachmentBuffer());
  reg.registerBuffer(createVolumeFieldBuffer());
  reg.registerSystem(createBodyLeanSystem());

  const rigBuf = reg.getBuffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID);
  writeBuffer(rigBuf, (d) => { d.byId.set(BIPED.id, BIPED); });

  const skel = reg.getBuffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
  const tf = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  const vel = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
  const surf = reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);
  const vf = reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID);

  writeBuffer(skel, (d) => { d.byEntity.set(1, initSkeletonFromRig(BIPED)); });
  writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 0.5, 0], yaw: 0, scale: 1 }); });
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
  writeBuffer(surf, (d) => {
    d.byEntity.set(1, {
      surfaceId: "test",
      uv: [0.5, 0.5],
      offsetAlongNormal: 0.5,
      sample: {
        position: [0, 0, 0],
        normal: [0, 1, 0],
        tangentU: [1, 0, 0],
        tangentV: [0, 0, 1],
        tangentUNorm: 1,
        tangentVNorm: 1,
        slopeRad: 0,
        friction: 1,
        normalInMax: 800,
        normalOutMax: 200,
        traversable: true,
      },
    });
  });
  writeBuffer(vf, (d) => { d.gravity = [0, -9.81, 0]; });

  const g = buildExecutionGraph({ id: "g", nodes: [BODY_LEAN_SYSTEM_ID], registry: reg });
  return { reg, g, skel, tf, vel, cc };
}

function tickN(
  reg: ReturnType<typeof createRegistry>,
  g: ReturnType<typeof buildExecutionGraph>,
  count: number,
  dt = 0.016,
) {
  for (let i = 0; i < count; i++) executeGraph(g, reg, { dt, now: i * dt });
}

/** Set velocity steadily (no accel). */
function setSteadyVel(vel: ReturnType<typeof setup>["vel"], v: [number, number, number]) {
  writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: v, prevLinear: v }); });
}

describe("BodyLeanSystem", () => {
  it("at rest → pelvis rotation stays near identity (upright)", () => {
    const { reg, g, skel } = setup();
    tickN(reg, g, 60);
    const pelvis = readBuffer(skel).byEntity.get(1)!.bones[0];
    // Quaternion near identity: |x|, |y|, |z| small; w near 1.
    expect(Math.hypot(pelvis.localRot[0], pelvis.localRot[1], pelvis.localRot[2])).toBeLessThan(0.05);
    expect(Math.abs(pelvis.localRot[3])).toBeGreaterThan(0.99);
  });

  it("at rest → pelvis localPos.Y stays at bind height (no compression)", () => {
    const { reg, g, skel } = setup();
    tickN(reg, g, 60);
    const pelvis = readBuffer(skel).byEntity.get(1)!.bones[0];
    expect(pelvis.localPos[1]).toBeCloseTo(0.3, 4); // bind value
  });

  it("forward velocity at speed → pelvis tilts forward (rotation about +X is negative)", () => {
    const { reg, g, skel, vel } = setup();
    setSteadyVel(vel, [0, 0, -8]); // forward in three.js convention
    tickN(reg, g, 60);
    const pelvis = readBuffer(skel).byEntity.get(1)!.bones[0];
    // For a forward tilt (top tips toward -Z), the rotation quaternion has
    // a negative x component (rotation about +X by negative angle).
    expect(pelvis.localRot[0]).toBeLessThan(-0.05);
  });

  it("forward velocity → pelvis compresses (Y drops below bind)", () => {
    const { reg, g, skel, vel } = setup();
    setSteadyVel(vel, [0, 0, -8]);
    tickN(reg, g, 60);
    const pelvis = readBuffer(skel).byEntity.get(1)!.bones[0];
    expect(pelvis.localPos[1]).toBeLessThan(0.3 - 0.05);
  });

  it("hard braking accel → pelvis tilts backward (rotation about +X is positive)", () => {
    const { reg, g, skel, vel } = setup();
    // Velocity forward but accel backward.
    writeBuffer(vel, (d) => {
      d.byEntity.set(1, { linear: [0, 0, -4], prevLinear: [0, 0, -7] }); // accel ~+187 m/s² along Z (huge)
    });
    tickN(reg, g, 60);
    const pelvis = readBuffer(skel).byEntity.get(1)!.bones[0];
    expect(pelvis.localRot[0]).toBeGreaterThan(0.05);
  });

  it("sideways velocity → pelvis banks toward the strafe direction", () => {
    const { reg, g, skel, vel } = setup();
    setSteadyVel(vel, [8, 0, 0]); // moving in +X
    tickN(reg, g, 60);
    const pelvis = readBuffer(skel).byEntity.get(1)!.bones[0];
    // Banking right tips body so local +Y rotates toward +X → quaternion z is
    // negative (rotation about -Z axis).
    expect(pelvis.localRot[2]).toBeLessThan(-0.05);
  });

  it("airborne (volumeConstrained) with zero velocity → near-identity rotation", () => {
    const { reg, g, skel, cc } = setup();
    writeBuffer(cc, (d) => {
      const c = d.byEntity.get(1)!;
      c.locomotionMode = "volumeConstrained";
      d.byEntity.set(1, c);
    });
    tickN(reg, g, 60);
    const pelvis = readBuffer(skel).byEntity.get(1)!.bones[0];
    expect(Math.abs(pelvis.localRot[3])).toBeGreaterThan(0.99);
  });
});
