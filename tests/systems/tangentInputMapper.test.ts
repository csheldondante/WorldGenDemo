/**
 * Phase 5b — TangentInputMapper consumes ControllerParamsBuffer.
 *
 * Verifies vDesF / vDesR scale by `speedMultiplier` from the
 * CHARACTER_INTENT slot params. Default 1.0 = identical to pre-5b;
 * agile 1.6 = 60% faster; heavy 0.7 = 30% slower. Missing buffer
 * entry falls back to 1.0.
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
import { applyControllerBinding } from "../../src/runtime/controllerParams";
import { SLOT_CHARACTER_INTENT } from "../../src/runtime/slotIds";

function runOneTick(reg: Registry): CharacterTangentInputBufferData {
  const graph = buildExecutionGraph({
    id: "test",
    nodes: [TANGENT_INPUT_MAPPER_SYSTEM_ID],
    registry: reg,
  });
  executeGraph(graph, reg, { dt: 1 / 60, now: 0 });
  return readBuffer(reg.getBuffer<CharacterTangentInputBufferData>(CHARACTER_TANGENT_INPUT_BUFFER_ID));
}

function setup(): Registry {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createTangentInputMapperSystem());

  const id = 1;
  // moveY=1 (forward), camera looking +Z, world-up.
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
  writeBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID), (d) => {
    d.byId.set(DEFAULT_PLAYER_PROFILE.id, DEFAULT_PLAYER_PROFILE);
  });
  // Flat horizontal surface: normal=+Y, tangentU=+X, tangentV=+Z.
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

describe("TangentInputMapper — Phase 5b speedMultiplier", () => {
  it("default (no binding applied) → vDesF = xIntercept of forward curve (= multiplier 1.0)", () => {
    const reg = setup();
    const ti = runOneTick(reg);
    const t = ti.byEntity.get(1)!;
    expect(t.vDesF).toBeCloseTo(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax, 5);
  });

  it("speedMultiplier=1.6 (agile) scales vDesF up by 60%", () => {
    const reg = setup();
    applyControllerBinding(reg, {
      id: "test:agile",
      bindings: {},
      paramOverrides: { [SLOT_CHARACTER_INTENT]: { speedMultiplier: 1.6 } },
    });
    const t = runOneTick(reg).byEntity.get(1)!;
    expect(t.vDesF).toBeCloseTo(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax * 1.6, 5);
  });

  it("speedMultiplier=0.7 (heavy) scales vDesF down by 30%", () => {
    const reg = setup();
    applyControllerBinding(reg, {
      id: "test:heavy",
      bindings: {},
      paramOverrides: { [SLOT_CHARACTER_INTENT]: { speedMultiplier: 0.7 } },
    });
    const t = runOneTick(reg).byEntity.get(1)!;
    expect(t.vDesF).toBeCloseTo(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax * 0.7, 5);
  });

  it("binding without CHARACTER_INTENT params → vDesF unchanged (= 1.0 default)", () => {
    const reg = setup();
    applyControllerBinding(reg, {
      id: "test:no-intent",
      bindings: {},
      paramOverrides: {}, // empty
    });
    const t = runOneTick(reg).byEntity.get(1)!;
    expect(t.vDesF).toBeCloseTo(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax, 5);
  });
});
