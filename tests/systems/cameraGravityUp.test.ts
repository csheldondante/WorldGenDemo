/**
 * cameraFollowSystem orbits the player on a sphere of fixed radius around
 * `up = -normalize(gravity)`. Verifies:
 *
 *  - Yaw rotates the camera around the up axis without changing distance to player.
 *  - Pitch elevates the camera above the orbit horizon (no horizontal motion).
 *  - On a radial-away cylinder gravity volume, up swings to the radial-inward
 *    direction (not world +Y), so the camera orbits the player around that axis.
 *  - When the entity has no gravity (zero volume + zero universal gravity), the
 *    camera falls back to world +Y up.
 *  - Pitch is clamped near the poles (camera never reaches "directly above").
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

function runCamera(reg: ReturnType<typeof createRegistry>, yaw: number, pitch: number) {
  writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
    d.yaw = yaw; d.pitch = pitch;
  });
  const g = buildExecutionGraph({ id: "cam", nodes: ["cameraFollowSystem"], registry: reg });
  executeGraph(g, reg, { dt: 0.016, now: 0 });
  return readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe("Spherical camera around gravity-up", () => {
  it("flat ground: yaw rotates around world +Y at constant distance", () => {
    const reg = setupRegistry();
    const playerPos: [number, number, number] = [10, 5, -3];
    placePlayer(reg, playerPos);

    const cam0 = runCamera(reg, 0, 0); // pitch=0 → in horizon plane behind player
    const cam90 = runCamera(reg, Math.PI / 2, 0);

    // Distance from player invariant under yaw.
    expect(dist(cam0.pos, playerPos)).toBeCloseTo(FOLLOW_DISTANCE, 5);
    expect(dist(cam90.pos, playerPos)).toBeCloseTo(FOLLOW_DISTANCE, 5);
    // Y stays at player's elevation (pitch=0 → in horizon plane).
    expect(cam0.pos[1]).toBeCloseTo(playerPos[1], 5);
    expect(cam90.pos[1]).toBeCloseTo(playerPos[1], 5);
    // up is world +Y.
    expect(cam0.up[1]).toBeCloseTo(1, 5);
  });

  it("flat ground: pitch lifts the camera along +Y without horizontal motion", () => {
    const reg = setupRegistry();
    const playerPos: [number, number, number] = [0, 0, 0];
    placePlayer(reg, playerPos);

    const cam = runCamera(reg, 0, Math.PI / 4); // 45° above the horizon
    // Distance from player still equals FOLLOW_DISTANCE.
    expect(dist(cam.pos, playerPos)).toBeCloseTo(FOLLOW_DISTANCE, 5);
    // Vertical = sin(π/4)·R; horizontal = cos(π/4)·R.
    expect(cam.pos[1]).toBeCloseTo(FOLLOW_DISTANCE * Math.SQRT1_2, 5);
    const horiz = Math.hypot(cam.pos[0], cam.pos[2]);
    expect(horiz).toBeCloseTo(FOLLOW_DISTANCE * Math.SQRT1_2, 5);
  });

  it("radial-away cylinder gravity, character offset along +X → up is -X; camera orbits in YZ plane", () => {
    const reg = setupRegistry();
    // Concave wall: axis +Y at origin, radius 12. Place character on inside at +X side.
    const playerPos: [number, number, number] = [11.7, 0, 0];
    placePlayer(reg, playerPos);
    writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
      d.gravity = [0, -9.81, 0];
      d.volumes = [{
        shape: { type: "cylinder", axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], radius: 13, halfHeight: 15 },
        field: { type: "radial", axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], direction: "away", magnitude: 9.81 },
        priority: 1,
      }];
    });

    const cam = runCamera(reg, 0, 0);
    // up should be -X (gravity points +X here).
    expect(cam.up[0]).toBeCloseTo(-1, 5);
    expect(cam.up[1]).toBeCloseTo(0, 5);
    expect(cam.up[2]).toBeCloseTo(0, 5);
    // Distance invariant.
    expect(dist(cam.pos, playerPos)).toBeCloseTo(FOLLOW_DISTANCE, 5);
    // pitch=0 → camera stays in the up-tangent plane (no -X offset from player).
    expect(cam.pos[0]).toBeCloseTo(playerPos[0], 5);

    // Pitch lifts camera along up axis = -X direction.
    const camPitched = runCamera(reg, 0, Math.PI / 4);
    expect(camPitched.pos[0]).toBeCloseTo(playerPos[0] - FOLLOW_DISTANCE * Math.SQRT1_2, 5);
    expect(dist(camPitched.pos, playerPos)).toBeCloseTo(FOLLOW_DISTANCE, 5);
  });

  it("zero gravity → up falls back to world +Y", () => {
    const reg = setupRegistry();
    placePlayer(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
      d.gravity = [0, 0, 0];
      d.volumes = [];
    });
    const cam = runCamera(reg, 0, 0);
    expect(cam.up[0]).toBeCloseTo(0, 5);
    expect(cam.up[1]).toBeCloseTo(1, 5);
    expect(cam.up[2]).toBeCloseTo(0, 5);
  });

  it("pitch is clamped near the poles", () => {
    const reg = setupRegistry();
    placePlayer(reg, [0, 0, 0]);
    const cam = runCamera(reg, 0, 99); // huge input → should clamp
    // Pitch never reaches π/2 (capped); equivalently the camera never sits at the up pole.
    expect(cam.pitch).toBeLessThan(Math.PI / 2 - 0.01);
    expect(cam.pitch).toBeGreaterThan(0);
  });
});
