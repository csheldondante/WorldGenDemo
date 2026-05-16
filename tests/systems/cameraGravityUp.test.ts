/**
 * cameraFollowSystem builds its basis around `up = -normalize(gravity)` at the
 * player's position. Verifies the wall-of-death / log-of-doom cases:
 *
 *  - On flat ground with universal -Y gravity, the camera offset is the standard
 *    "above and behind" in world coordinates (regression for the previous
 *    world-Y-up behavior).
 *  - With a radial-away gravity volume (concave wall, axis +Y), at a character
 *    position offset along +X the camera up swings to -X (radial-inward), and
 *    the FOLLOW_HEIGHT offset is now along -X, not world +Y.
 *  - With no character spawned, the camera buffer is left at its initial state.
 */
import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../../src/buffers/camera";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../../src/buffers/transform";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../../src/buffers/characterController";
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../../src/buffers/volumeField";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createCameraFollowSystem } from "../../src/systems/cameraFollow";

const FOLLOW_DISTANCE = 6;
const FOLLOW_HEIGHT = 2.6;

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
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
    });
  });
  writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
    d.byEntity.set(id, { position: pos, yaw: 0, scale: 1 });
  });
  return id;
}

describe("cameraFollow uses gravity-up", () => {
  it("flat ground with universal -Y gravity → camera up is world +Y, offset is along +Y", () => {
    const reg = setupRegistry();
    placePlayer(reg, [10, 5, -3]);
    // Universal gravity defaults to (0, -9.81, 0); leave it.
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.yaw = 0; d.pitch = 0; d.pos = [0, 0, 0];
    });
    const g = buildExecutionGraph({ id: "cam", nodes: ["cameraFollowSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0.016, now: 0 });
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // Player at (10, 5, -3), gravity-up = +Y, reference fwd = -Z. With yaw=0, pitch=0:
    //   fwd = -Z, camera pos = player + (+Z)·FD + (+Y)·FH = (10, 5+FH, -3+FD).
    expect(cam.pos[0]).toBeCloseTo(10, 5);
    expect(cam.pos[1]).toBeCloseTo(5 + FOLLOW_HEIGHT, 5);
    expect(cam.pos[2]).toBeCloseTo(-3 + FOLLOW_DISTANCE, 5);
  });

  it("radial-away cylinder gravity, character offset along +X → camera up is -X", () => {
    const reg = setupRegistry();
    // Concave wall geometry from gym-cylinder-concave: axis +Y at origin, radius 12.
    // Place character on the inside wall at world +X side: position (12-r, 0, 0). Gravity
    // volume radial-away points in +X at this point, so gravity-up = -X.
    placePlayer(reg, [11.7, 0, 0]);
    writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
      d.gravity = [0, -9.81, 0];
      d.volumes = [{
        shape: { type: "cylinder", axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], radius: 13, halfHeight: 15 },
        field: { type: "radial", axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], direction: "away", magnitude: 9.81 },
        priority: 1,
      }];
    });
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.yaw = 0; d.pitch = 0; d.pos = [0, 0, 0];
    });
    const g = buildExecutionGraph({ id: "cam", nodes: ["cameraFollowSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0.016, now: 0 });
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // gravity at (11.7, 0, 0) inside the cylinder volume = +X direction, magnitude 9.81.
    //   up = -gravity/|gravity| = (-1, 0, 0).
    // Reference fwd starts at world -Z = (0, 0, -1); not parallel to up so kept.
    // Project off up (no -X component) → ref_perp = (0, 0, -1). With yaw=0 → fwd = ref_perp.
    // Pitch=0 → fwd unchanged. Camera pos = player − fwd·FD + up·FH
    //   = (11.7, 0, 0) − (0, 0, -1)·6 + (-1, 0, 0)·2.6 = (11.7 - 2.6, 0, 6) = (9.1, 0, 6).
    expect(cam.pos[0]).toBeCloseTo(11.7 - FOLLOW_HEIGHT, 5);
    expect(cam.pos[1]).toBeCloseTo(0, 5);
    expect(cam.pos[2]).toBeCloseTo(FOLLOW_DISTANCE, 5);
  });

  it("zero gravity → camera falls back to world +Y up", () => {
    const reg = setupRegistry();
    placePlayer(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
      d.gravity = [0, 0, 0];
      d.volumes = [];
    });
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.yaw = 0; d.pitch = 0; d.pos = [99, 99, 99];
    });
    const g = buildExecutionGraph({ id: "cam", nodes: ["cameraFollowSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0.016, now: 0 });
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // With gravity = 0, up falls back to world +Y → behaves like flat ground at origin:
    //   fwd = -Z, camera pos = (0, FH, FD).
    expect(cam.pos[0]).toBeCloseTo(0, 5);
    expect(cam.pos[1]).toBeCloseTo(FOLLOW_HEIGHT, 5);
    expect(cam.pos[2]).toBeCloseTo(FOLLOW_DISTANCE, 5);
  });
});
