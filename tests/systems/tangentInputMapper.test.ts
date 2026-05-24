/**
 * TangentInputMapperSystem — the input → tangent-frame projection
 * reads `CharacterControllerProfile` for the active profileId and
 * uses its forward/backward/lateral accel curves to compute vDes.
 *
 * The contract verified here: when a different
 * CharacterControllerProfile is installed in the buffer (= via
 * `applyControllerBinding`), the system reads the new curves and
 * produces a different vDes. This replaces the prior 5b "multiplier
 * scaling" tests — the same outcome reached via the canonical model
 * (profile is the source of truth), not via an over-layer.
 */

import { describe, it, expect } from "vitest";
import { createRegistry, type Registry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import {
  CHARACTER_INPUT_BUFFER_ID,
  type CharacterInputBufferData,
  emptyInput,
} from "../../src/buffers/characterInput";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../../src/buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
  type CharacterControllerProfile,
  DEFAULT_PLAYER_PROFILE,
} from "../../src/buffers/characterControllerProfile";
import {
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../../src/buffers/surfaceAttachment";
import {
  FORCE_ACCUMULATOR_BUFFER_ID,
  type ForceAccumulatorBufferData,
} from "../../src/buffers/forceAccumulator";
import {
  CHARACTER_TANGENT_INPUT_BUFFER_ID,
  type CharacterTangentInputBufferData,
} from "../../src/buffers/characterTangentInput";
import {
  createTangentInputMapperSystem,
  TANGENT_INPUT_MAPPER_SYSTEM_ID,
} from "../../src/systems/tangentInputMapper";

function runOneTick(reg: Registry): CharacterTangentInputBufferData {
  const graph = buildExecutionGraph({
    id: "test",
    nodes: [TANGENT_INPUT_MAPPER_SYSTEM_ID],
    registry: reg,
  });
  executeGraph(graph, reg, { dt: 1 / 60, now: 0 });
  return readBuffer(reg.getBuffer<CharacterTangentInputBufferData>(CHARACTER_TANGENT_INPUT_BUFFER_ID));
}

function setup(profile: CharacterControllerProfile): Registry {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createTangentInputMapperSystem());

  const id = 1;
  writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      ...emptyInput(0),
      moveY: 1,
      cameraLookDir: [0, 0, 1],
      cameraUp: [0, 1, 0],
    });
  });
  writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      locomotionMode: "surfaceConstrained",
      state: "surfaceRun",
      profileId: profile.id,
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
  writeBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID), (d) => {
    d.byId.set(profile.id, profile);
  });
  writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      surfaceId: "plane",
      uv: [0, 0],
      offsetAlongNormal: 0,
      sample: {
        position: [0, 0, 0],
        normal: [0, 1, 0],
        tangentU: [1, 0, 0],
        tangentV: [0, 0, 1],
        tangentUNorm: 1,
        tangentVNorm: 1,
        slopeRad: 0,
        friction: 1,
        normalInMax: 1000,
        normalOutMax: 1000,
        traversable: true,
      },
    });
  });
  writeBuffer(reg.getBuffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID), (d) => {
    d.byEntity.set(id, { accel: [0, 0, 0] });
  });
  return reg;
}

describe("TangentInputMapper — profile is the source of truth", () => {
  it("vDesF equals forwardAccel.vMax (= xIntercept under zero external accel) for the default profile", () => {
    const reg = setup(DEFAULT_PLAYER_PROFILE);
    const t = runOneTick(reg).byEntity.get(1)!;
    expect(t.vDesF).toBeCloseTo(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax, 5);
  });

  it("installing a profile with 1.6× forwardAccel.vMax produces 1.6× vDesF (= agile-style binding)", () => {
    const agileProfile: CharacterControllerProfile = {
      ...DEFAULT_PLAYER_PROFILE,
      forwardAccel: {
        ...DEFAULT_PLAYER_PROFILE.forwardAccel,
        vMax: DEFAULT_PLAYER_PROFILE.forwardAccel.vMax * 1.6,
      },
    };
    const reg = setup(agileProfile);
    const t = runOneTick(reg).byEntity.get(1)!;
    expect(t.vDesF).toBeCloseTo(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax * 1.6, 5);
  });

  it("installing a profile with 0.7× forwardAccel.vMax produces 0.7× vDesF (= heavy-style binding)", () => {
    const heavyProfile: CharacterControllerProfile = {
      ...DEFAULT_PLAYER_PROFILE,
      forwardAccel: {
        ...DEFAULT_PLAYER_PROFILE.forwardAccel,
        vMax: DEFAULT_PLAYER_PROFILE.forwardAccel.vMax * 0.7,
      },
    };
    const reg = setup(heavyProfile);
    const t = runOneTick(reg).byEntity.get(1)!;
    expect(t.vDesF).toBeCloseTo(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax * 0.7, 5);
  });

  it("mutating the profile in-buffer between ticks immediately changes the produced vDes", () => {
    const reg = setup(DEFAULT_PLAYER_PROFILE);
    const t0 = runOneTick(reg).byEntity.get(1)!;
    expect(t0.vDesF).toBeCloseTo(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax, 5);
    // Simulate applyControllerBinding installing a different profile.
    writeBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID), (d) => {
      d.byId.set(DEFAULT_PLAYER_PROFILE.id, {
        ...DEFAULT_PLAYER_PROFILE,
        forwardAccel: { ...DEFAULT_PLAYER_PROFILE.forwardAccel, vMax: 42 },
      });
    });
    const t1 = runOneTick(reg).byEntity.get(1)!;
    expect(t1.vDesF).toBeCloseTo(42, 5);
  });
});
