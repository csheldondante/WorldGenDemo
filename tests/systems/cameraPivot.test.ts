import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
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
  createVolumeFieldBuffer,
  VOLUME_FIELD_BUFFER_ID,
  type VolumeFieldBufferData,
} from "../../src/buffers/volumeField";
import {
  createCameraPivotSystem,
  CAMERA_PIVOT_SYSTEM_ID,
} from "../../src/systems/cameraPivot";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createCameraBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerBuffer(createVolumeFieldBuffer());
  reg.registerSystem(createCameraPivotSystem());
  const graph = buildExecutionGraph({
    id: "test",
    nodes: [CAMERA_PIVOT_SYSTEM_ID],
    registry: reg,
  });
  return { reg, graph };
}

function tick(reg: ReturnType<typeof setup>["reg"], graph: ReturnType<typeof setup>["graph"], dt = 1 / 60) {
  executeGraph(graph, reg, { now: 0, dt });
}

function spawnDummyCharacter(reg: ReturnType<typeof setup>["reg"], id: number, position: [number, number, number]) {
  writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
    d.byEntity.set(id, { position, yaw: 0, scale: 1 });
  });
  writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      state: "surfaceRun", locomotionMode: "surfaceConstrained",
      profileId: "player", lastTransitionReason: "spawn", transitions: [],
      timeInState: 0, yawVel: 0, targetYaw: 0,
      bodyUpCurrent: [0, 0, 0, 1], bodyUpWorld: [0, 1, 0],
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
    });
  });
}

function setHugeResponsiveness(reg: ReturnType<typeof setup>["reg"]) {
  writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
    d.params.pivotResponsiveness = 1e6;  // effectively instant chase
  });
}

describe("cameraPivotSystem", () => {
  it("at responsiveness→∞, pivot.position snaps to the followed character's transform", () => {
    const { reg, graph } = setup();
    setHugeResponsiveness(reg);
    spawnDummyCharacter(reg, 7, [3, 4, 5]);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pivot.position[0]).toBeCloseTo(3, 9);
    expect(cam.pivot.position[1]).toBeCloseTo(4, 9);
    expect(cam.pivot.position[2]).toBeCloseTo(5, 9);
  });

  it("at finite responsiveness, pivot.position lags but converges toward the character", () => {
    const { reg, graph } = setup();
    spawnDummyCharacter(reg, 1, [10, 0, 0]);
    // Start with pivot at origin. One tick at dt=1/60 with default rate=12
    // should move ~18% of the way (alpha = 1 - exp(-1/60·12) ≈ 0.181).
    tick(reg, graph);
    const after1 = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(after1.pivot.position[0]).toBeGreaterThan(1.5);
    expect(after1.pivot.position[0]).toBeLessThan(2.5);
    // After 120 ticks (2 s) it should be very close.
    for (let i = 0; i < 119; i++) tick(reg, graph);
    const afterMany = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(afterMany.pivot.position[0]).toBeCloseTo(10, 5);
  });

  it("pivot.up tracks negated, normalized gravity vector from volumeField", () => {
    const { reg, graph } = setup();
    setHugeResponsiveness(reg);
    spawnDummyCharacter(reg, 1, [0, 0, 0]);
    // Default gravity = (0, -9.81, 0) → up should be (0, 1, 0).
    tick(reg, graph);
    let cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pivot.up[0]).toBeCloseTo(0, 9);
    expect(cam.pivot.up[1]).toBeCloseTo(1, 9);
    expect(cam.pivot.up[2]).toBeCloseTo(0, 9);

    // Flip universal gravity to point +X → up should track to (-1, 0, 0).
    writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
      d.gravity = [9.81, 0, 0];
    });
    tick(reg, graph);
    cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pivot.up[0]).toBeCloseTo(-1, 9);
    expect(cam.pivot.up[1]).toBeCloseTo(0, 9);
    expect(cam.pivot.up[2]).toBeCloseTo(0, 9);
  });

  it("pivot.fwd parallel-transports onto the plane ⊥ pivot.up (stays perpendicular as up rotates)", () => {
    const { reg, graph } = setup();
    setHugeResponsiveness(reg);
    spawnDummyCharacter(reg, 1, [0, 0, 0]);
    // Start: gravity -Y, up = +Y, fwd = -Z. fwd·up = 0. ✓
    // Rotate gravity to point +X → up becomes -X. fwd should stay -Z
    // (project (-Z) onto plane ⊥ (-X) = (-Z) itself; both perpendicular).
    writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
      d.gravity = [9.81, 0, 0];
    });
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    const fwdDotUp = cam.pivot.fwd[0] * cam.pivot.up[0]
                   + cam.pivot.fwd[1] * cam.pivot.up[1]
                   + cam.pivot.fwd[2] * cam.pivot.up[2];
    expect(Math.abs(fwdDotUp)).toBeLessThan(1e-9);
    // Magnitude should remain unit.
    const fwdLen = Math.hypot(cam.pivot.fwd[0], cam.pivot.fwd[1], cam.pivot.fwd[2]);
    expect(fwdLen).toBeCloseTo(1, 9);
  });

  it("leaves the camera buffer alone when no character is registered (Loading state)", () => {
    const { reg, graph } = setup();
    const camBuf = reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID);
    const before = readBuffer(camBuf);
    const beforePos = before.pivot.position.slice();
    tick(reg, graph);
    const after = readBuffer(camBuf);
    expect(after.pivot.position).toEqual(beforePos);
  });
});
