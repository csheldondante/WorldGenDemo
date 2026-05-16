/**
 * cameraFollowSystem — offset-vector model. The camera-to-target offset is
 * persistent state; user input rotates it. Verifies:
 *
 *  - Camera position = target + offset (after renormalization to FOLLOW_DISTANCE).
 *  - Yaw lookDelta rotates offset around `up` (orbit around player) at constant radius.
 *  - Pitch lookDelta rotates offset toward/away from `up` (elevation).
 *  - On a radial-away cylinder gravity volume, up swings to the radial-inward
 *    direction; offset stays the same in world space but is renormalized.
 *  - Zero gravity → up falls back to world +Y.
 *  - Pole clamp keeps offset away from being parallel to up.
 */
import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../../src/buffers/camera";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../../src/buffers/inputMap";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../../src/buffers/transform";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../../src/buffers/characterController";
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../../src/buffers/volumeField";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createCameraFollowSystem } from "../../src/systems/cameraFollow";

const FOLLOW_DISTANCE = 6.5;

function setupRegistry() {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createCameraFollowSystem());
  return reg;
}

function placePlayer(reg: ReturnType<typeof createRegistry>, pos: [number, number, number]) {
  const id = 1;
  writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
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
    });
  });
  writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
    d.byEntity.set(id, { position: pos, yaw: 0, scale: 1 });
  });
  return id;
}

function runCamera(reg: ReturnType<typeof createRegistry>, opts: { dyaw?: number; dpitch?: number; offset?: [number, number, number] }) {
  writeBuffer(reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID), (d) => {
    d.lookDelta = { yaw: opts.dyaw ?? 0, pitch: opts.dpitch ?? 0 };
  });
  if (opts.offset) {
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.offset = opts.offset!;
    });
  }
  const g = buildExecutionGraph({ id: "cam", nodes: ["cameraFollowSystem"], registry: reg });
  executeGraph(g, reg, { dt: 0.016, now: 0 });
  return readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("cameraFollow — offset-vector model", () => {
  it("flat ground: pos = target + offset (renormalized to FOLLOW_DISTANCE)", () => {
    const reg = setupRegistry();
    const playerPos: [number, number, number] = [10, 5, -3];
    placePlayer(reg, playerPos);
    const cam = runCamera(reg, { offset: [0, 2.6, 6.5] });
    expect(dist(cam.pos, playerPos)).toBeCloseTo(FOLLOW_DISTANCE, 5);
    // Up is world +Y (universal -Y gravity).
    expect(cam.up[1]).toBeCloseTo(1, 5);
  });

  it("yaw lookDelta rotates offset around up; distance stays constant", () => {
    const reg = setupRegistry();
    placePlayer(reg, [0, 0, 0]);
    // Default offset (0, 2.6, 6.5) renormalized — camera in +Y/+Z quadrant.
    // 90° yaw around +Y: +Z → +X. Expect offset.x positive.
    const cam = runCamera(reg, { dyaw: Math.PI / 2, offset: [0, 2.6, 6.5] });
    expect(dist(cam.pos, [0, 0, 0])).toBeCloseTo(FOLLOW_DISTANCE, 5);
    expect(cam.offset[0]).toBeGreaterThan(0.5); // rotated into +X
    expect(Math.abs(cam.offset[2])).toBeLessThan(1e-5); // Z component zeroed
  });

  it("pitch lookDelta tilts offset toward up; distance constant", () => {
    const reg = setupRegistry();
    placePlayer(reg, [0, 0, 0]);
    // Start with horizontal offset; positive pitch should tilt toward +Y.
    const cam = runCamera(reg, { dpitch: 0.5, offset: [0, 0, 6.5] });
    expect(dist(cam.pos, [0, 0, 0])).toBeCloseTo(FOLLOW_DISTANCE, 5);
    expect(cam.offset[1]).toBeGreaterThan(0.5); // tilted up
  });

  it("radial-away cylinder gravity → up swings to -X at +X-side wall position", () => {
    const reg = setupRegistry();
    placePlayer(reg, [11.7, 0, 0]);
    writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
      d.gravity = [0, -9.81, 0];
      d.volumes = [{
        shape: { type: "cylinder", axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], radius: 13, halfHeight: 15 },
        field: { type: "radial", axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], direction: "away", magnitude: 9.81 },
        priority: 1,
      }];
    });
    const cam = runCamera(reg, { offset: [0, 0, 6.5] }); // pure +Z offset
    expect(cam.up[0]).toBeCloseTo(-1, 5);
    expect(cam.up[1]).toBeCloseTo(0, 5);
    // Pos = target + offset (renormalized).
    expect(cam.pos[0]).toBeCloseTo(11.7, 5);
    expect(cam.pos[2]).toBeCloseTo(6.5, 5);
  });

  it("zero gravity → up falls back to world +Y", () => {
    const reg = setupRegistry();
    placePlayer(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
      d.gravity = [0, 0, 0];
      d.volumes = [];
    });
    const cam = runCamera(reg, {});
    expect(cam.up[0]).toBeCloseTo(0, 5);
    expect(cam.up[1]).toBeCloseTo(1, 5);
    expect(cam.up[2]).toBeCloseTo(0, 5);
  });

  it("pole clamp keeps offset away from being parallel to up", () => {
    const reg = setupRegistry();
    placePlayer(reg, [0, 0, 0]);
    // Apply huge pitch delta; offset should be clamped near (but not at) the pole.
    const cam = runCamera(reg, { dpitch: 99, offset: [0, 0, 6.5] });
    // Up = +Y. offset shouldn't be aligned with +Y or -Y; |dot(offset_unit, up)| < 1.
    const dot = (cam.offset[0] * cam.up[0] + cam.offset[1] * cam.up[1] + cam.offset[2] * cam.up[2]) / FOLLOW_DISTANCE;
    expect(Math.abs(dot)).toBeLessThan(0.999);
  });
});
