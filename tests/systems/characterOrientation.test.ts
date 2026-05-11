import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  createInputMapBuffer,
  INPUT_MAP_BUFFER_ID,
  type InputMapBufferData,
} from "../../src/buffers/inputMap";
import {
  createCameraBuffer,
  CAMERA_BUFFER_ID,
  type CameraBufferData,
} from "../../src/buffers/camera";
import {
  createTransformBuffer,
  TRANSFORM_BUFFER_ID,
  type TransformBufferData,
} from "../../src/buffers/transform";
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
  createCharacterOrientationSystem,
  CHARACTER_ORIENTATION_SYSTEM_ID,
} from "../../src/systems/characterOrientation";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createInputMapBuffer());
  reg.registerBuffer(createCameraBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerBuffer(createCharacterControllerProfileBuffer());
  reg.registerSystem(createCharacterOrientationSystem());

  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
  const tf = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  const im = reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID);
  const cam = reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID);

  writeBuffer(cc, (d) => {
    d.byEntity.set(1, {
      state: "surfaceRun",
      locomotionMode: "surfaceConstrained",
      profileId: DEFAULT_PLAYER_PROFILE.id,
      lastTransitionReason: "spawn",
      timeInState: 0,
      yawVel: 0,
      targetYaw: 0,
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
    });
  });
  writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: 0, scale: 1 }); });

  const g = buildExecutionGraph({ id: "g", nodes: [CHARACTER_ORIENTATION_SYSTEM_ID], registry: reg });
  return { reg, g, cc, tf, im, cam };
}

/** Mark look input active so the orientation system latches camera yaw into targetYaw. */
function activateLook(im: ReturnType<typeof setup>["im"], yawDelta = 0.05) {
  writeBuffer(im, (d) => { d.lookDelta = { yaw: yawDelta, pitch: 0 }; });
}

function tickN(
  reg: ReturnType<typeof createRegistry>,
  g: ReturnType<typeof buildExecutionGraph>,
  count: number,
  dt = 0.016,
) {
  for (let i = 0; i < count; i++) executeGraph(g, reg, { dt, now: i * dt });
}

describe("CharacterOrientationSystem", () => {
  it("no input + camera matched → yaw stays at zero, no rotation", () => {
    const { reg, g, cc, tf } = setup();
    tickN(reg, g, 30);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0, 6);
    expect(readBuffer(cc).byEntity.get(1)!.yawVel).toBeCloseTo(0, 6);
  });

  it("camera turned with look input active → body chases to camera yaw", () => {
    const { reg, g, cc, tf, cam, im } = setup();
    writeBuffer(cam, (d) => { d.yaw = Math.PI / 2; });
    activateLook(im);
    tickN(reg, g, 5);
    const earlyYaw = readBuffer(tf).byEntity.get(1)!.yaw;
    expect(earlyYaw).toBeGreaterThan(0);
    tickN(reg, g, 60);
    const lateYaw = readBuffer(tf).byEntity.get(1)!.yaw;
    expect(lateYaw).toBeGreaterThan(earlyYaw);
    expect(lateYaw).toBeGreaterThan(Math.PI / 2 - 0.05);
    expect(lateYaw).toBeLessThan(Math.PI / 2 + 0.05);
    expect(Math.abs(readBuffer(cc).byEntity.get(1)!.yawVel)).toBeLessThan(0.5);
  });

  it("camera moved but look input idle (lookDelta=0) → body does NOT chase camera", () => {
    const { reg, g, tf, cam } = setup();
    writeBuffer(cam, (d) => { d.yaw = Math.PI / 2; });
    // No activateLook → lookDelta stays zero → target stays at 0 → body stays.
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0, 4);
  });

  it("strafe input alone does NOT rotate the body (camera-driven-only orientation)", () => {
    const { reg, g, tf, im } = setup();
    writeBuffer(im, (d) => { d.moveAxis = { x: 1, y: 0 }; });
    // Movement axis is set but lookDelta is zero → body should hold.
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0, 4);
  });

  it("forward input alone does NOT rotate the body (movement is independent of orientation)", () => {
    const { reg, g, tf, im } = setup();
    writeBuffer(im, (d) => { d.moveAxis = { x: 0, y: 1 }; });
    tickN(reg, g, 30);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0, 4);
  });

  it("body holds last camera-driven target after the player stops moving the camera", () => {
    const { reg, g, tf, cam, im } = setup();
    // First, turn camera with active look — body should chase.
    writeBuffer(cam, (d) => { d.yaw = 1.0; });
    activateLook(im);
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(1.0, 1);

    // Now the camera moves to π/2 but the player isn't touching it (lookDelta=0).
    // Body should stay at the latched 1.0, NOT chase the new camera position.
    writeBuffer(cam, (d) => { d.yaw = Math.PI / 2; });
    writeBuffer(im, (d) => { d.lookDelta = { yaw: 0, pitch: 0 }; });
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(1.0, 1);
  });

  it("shortest-path wrap: camera near -π with active look turns the short way (negative)", () => {
    const { reg, g, tf, cam, im } = setup();
    writeBuffer(cam, (d) => { d.yaw = -Math.PI + 0.1; });
    activateLook(im);
    tickN(reg, g, 3);
    const yawAfterFew = readBuffer(tf).byEntity.get(1)!.yaw;
    expect(yawAfterFew).toBeLessThan(0);
  });

  it("respects turnAccelMax: from rest, yawVel rises no faster than profile cap × dt per tick", () => {
    const { reg, g, cc, cam, im } = setup();
    writeBuffer(cam, (d) => { d.yaw = Math.PI / 2; });
    activateLook(im);
    const dt = 0.016;
    executeGraph(g, reg, { dt, now: 0 });
    const yawVel = readBuffer(cc).byEntity.get(1)!.yawVel;
    expect(Math.abs(yawVel)).toBeLessThanOrEqual(DEFAULT_PLAYER_PROFILE.turnAccelMax * dt + 1e-6);
  });
});
