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
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
    });
  });
  writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: 0, scale: 1 }); });

  const g = buildExecutionGraph({ id: "g", nodes: [CHARACTER_ORIENTATION_SYSTEM_ID], registry: reg });
  return { reg, g, cc, tf, im, cam };
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

  it("camera turned to π/2 → body yaw chases toward π/2 over time", () => {
    const { reg, g, cc, tf, cam } = setup();
    writeBuffer(cam, (d) => { d.yaw = Math.PI / 2; });
    tickN(reg, g, 5);
    const earlyYaw = readBuffer(tf).byEntity.get(1)!.yaw;
    expect(earlyYaw).toBeGreaterThan(0);
    tickN(reg, g, 60);
    const lateYaw = readBuffer(tf).byEntity.get(1)!.yaw;
    expect(lateYaw).toBeGreaterThan(earlyYaw);
    expect(lateYaw).toBeGreaterThan(Math.PI / 2 - 0.05);
    expect(lateYaw).toBeLessThan(Math.PI / 2 + 0.05);
    // Velocity damped to near zero on settle.
    expect(Math.abs(readBuffer(cc).byEntity.get(1)!.yawVel)).toBeLessThan(0.5);
  });

  it("forward input + camera yaw=0 → target is camera yaw, body stays facing forward", () => {
    const { reg, g, tf, im } = setup();
    writeBuffer(im, (d) => { d.moveAxis = { x: 0, y: 1 }; });
    tickN(reg, g, 30);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0, 3);
  });

  it("right strafe + camera yaw=0 → target is camera-relative right (yaw = -π/2)", () => {
    const { reg, g, tf, im } = setup();
    writeBuffer(im, (d) => { d.moveAxis = { x: 1, y: 0 }; });
    tickN(reg, g, 120);
    const yaw = readBuffer(tf).byEntity.get(1)!.yaw;
    // Right strafe in three.js convention faces yaw=-π/2.
    expect(yaw).toBeLessThan(-1.4);
    expect(yaw).toBeGreaterThan(-1.7);
  });

  it("backward input (moveY = -1) does NOT spin the body — yaw stays near camera yaw", () => {
    const { reg, g, tf, im } = setup();
    writeBuffer(im, (d) => { d.moveAxis = { x: 0, y: -1 }; });
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0, 2);
  });

  it("shortest-path wrap: camera at π+0.1 with body at 0 turns the short way (negative)", () => {
    const { reg, g, tf, cam } = setup();
    // Camera at -π + 0.1 (just past the wrap boundary). Shortest path is
    // backward (negative direction), not forward through positive.
    writeBuffer(cam, (d) => { d.yaw = -Math.PI + 0.1; });
    tickN(reg, g, 3);
    const yawAfterFew = readBuffer(tf).byEntity.get(1)!.yaw;
    expect(yawAfterFew).toBeLessThan(0); // turned in the short direction
  });

  it("respects turnAccelMax: from rest, yawVel rises no faster than profile cap × dt per tick", () => {
    const { reg, g, cc, cam } = setup();
    writeBuffer(cam, (d) => { d.yaw = Math.PI / 2; });
    const dt = 0.016;
    executeGraph(g, reg, { dt, now: 0 });
    const yawVel = readBuffer(cc).byEntity.get(1)!.yawVel;
    expect(Math.abs(yawVel)).toBeLessThanOrEqual(DEFAULT_PLAYER_PROFILE.turnAccelMax * dt + 1e-6);
  });
});
