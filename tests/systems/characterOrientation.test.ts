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
import { createSurfaceAttachmentBuffer } from "../../src/buffers/surfaceAttachment";
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
  // SurfaceAttachmentBuffer is read by characterOrientation to project camera
  // yaw onto the surface tangent plane. With no entry seeded for entity 1,
  // the system falls back to N = +Y, reducing to the legacy flat-Y math —
  // exactly what these tests pin.
  reg.registerBuffer(createSurfaceAttachmentBuffer());
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
      transitions: [],
      timeInState: 0,
      yawVel: 0,
      targetYaw: 0,
      bodyUpCurrent: [0, 0, 0, 1],
      bodyUpWorld: [0, 1, 0],
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      desiredFacingTangent: [0, 0, -1],
    });
  });
  writeBuffer(tf, (d) => { d.byEntity.set(1, { position: [0, 0, 0], yaw: 0, scale: 1 }); });

  const g = buildExecutionGraph({ id: "g", nodes: [CHARACTER_ORIENTATION_SYSTEM_ID], registry: reg });
  return { reg, g, cc, tf, im, cam };
}

function activateLook(im: ReturnType<typeof setup>["im"], yawDelta = 0.05) {
  writeBuffer(im, (d) => { d.lookDelta = { yaw: yawDelta, pitch: 0 }; });
}

/**
 * Set cam.yaw AND cam.lookDir together. characterOrientation reads
 * cam.lookDir (the camera's 3D look direction) since the world-Y yaw
 * scalar is lossy on curved surfaces. Tests still want to drive the
 * camera by a single angle on flat ground; this helper sets the
 * matching look direction so the system sees a coherent camera pose.
 */
function setCamYaw(cam: ReturnType<typeof setup>["cam"], yaw: number) {
  writeBuffer(cam, (d) => {
    d.yaw = yaw;
    d.lookDir = [-Math.sin(yaw), 0, -Math.cos(yaw)];
  });
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
  it("idle player + idle camera → no rotation", () => {
    const { reg, g, cc, tf } = setup();
    tickN(reg, g, 30);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0, 6);
    expect(readBuffer(cc).byEntity.get(1)!.yawVel).toBeCloseTo(0, 6);
  });

  it("idle player + active look input → body chases camera", () => {
    const { reg, g, tf, cam, im } = setup();
    setCamYaw(cam, Math.PI / 2);
    activateLook(im);
    tickN(reg, g, 60);
    const yaw = readBuffer(tf).byEntity.get(1)!.yaw;
    expect(yaw).toBeGreaterThan(Math.PI / 2 - 0.05);
    expect(yaw).toBeLessThan(Math.PI / 2 + 0.05);
  });

  it("idle player + camera moved but no look input → body does NOT rotate", () => {
    const { reg, g, tf, cam } = setup();
    setCamYaw(cam, Math.PI / 2);
    // No activateLook → lookDelta stays zero → no movement → target stays at 0.
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0, 3);
  });

  it("forward movement → body aims at movement direction (= camera yaw)", () => {
    const { reg, g, tf, cam, im } = setup();
    setCamYaw(cam, 0.7);
    writeBuffer(im, (d) => { d.moveAxis = { x: 0, y: 1 }; });
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(0.7, 1);
  });

  it("right-strafe → body faces strafe direction (camera − π/2 for three.js convention)", () => {
    const { reg, g, tf, im } = setup();
    writeBuffer(im, (d) => { d.moveAxis = { x: 1, y: 0 }; });
    tickN(reg, g, 120);
    const yaw = readBuffer(tf).byEntity.get(1)!.yaw;
    expect(yaw).toBeLessThan(-1.4);
    expect(yaw).toBeGreaterThan(-1.7);
  });

  it("backward input pivots the body 180° (movement trumps camera)", () => {
    const { reg, g, tf, im } = setup();
    writeBuffer(im, (d) => { d.moveAxis = { x: 0, y: -1 }; });
    tickN(reg, g, 60);
    const yaw = Math.abs(readBuffer(tf).byEntity.get(1)!.yaw);
    expect(yaw).toBeCloseTo(Math.PI, 1);
  });

  it("after movement-driven turn, body holds when player stops and camera is idle", () => {
    const { reg, g, tf, cam, im } = setup();
    // Move forward with camera at 1.0 → body chases 1.0.
    setCamYaw(cam, 1.0);
    writeBuffer(im, (d) => { d.moveAxis = { x: 0, y: 1 }; });
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(1.0, 1);

    // Stop moving; camera idle. Body should hold at 1.0.
    writeBuffer(im, (d) => { d.moveAxis = { x: 0, y: 0 }; d.lookDelta = { yaw: 0, pitch: 0 }; });
    tickN(reg, g, 60);
    expect(readBuffer(tf).byEntity.get(1)!.yaw).toBeCloseTo(1.0, 1);
  });

  it("respects turnAccelMax: from rest, yawVel rises no faster than profile cap × dt per tick", () => {
    const { reg, g, cc, cam, im } = setup();
    setCamYaw(cam, Math.PI / 2);
    activateLook(im);
    const dt = 0.016;
    executeGraph(g, reg, { dt, now: 0 });
    const yawVel = readBuffer(cc).byEntity.get(1)!.yawVel;
    expect(Math.abs(yawVel)).toBeLessThanOrEqual(DEFAULT_PLAYER_PROFILE.turnAccelMax * dt + 1e-6);
  });
});
