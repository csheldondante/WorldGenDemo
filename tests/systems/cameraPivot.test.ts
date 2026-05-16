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
  createCameraPivotSystem,
  CAMERA_PIVOT_SYSTEM_ID,
} from "../../src/systems/cameraPivot";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createCameraBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerSystem(createCameraPivotSystem());
  const graph = buildExecutionGraph({
    id: "test",
    nodes: [CAMERA_PIVOT_SYSTEM_ID],
    registry: reg,
  });
  return { reg, graph };
}

function tick(reg: ReturnType<typeof setup>["reg"], graph: ReturnType<typeof setup>["graph"]) {
  executeGraph(graph, reg, { now: 0, dt: 1 / 60, frame: 0 });
}

describe("cameraPivotSystem", () => {
  it("snaps pivot.position to the followed character's transform", () => {
    const { reg, graph } = setup();
    const charId = 7;
    writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
      d.byEntity.set(charId, { position: [3, 4, 5], yaw: 0, scale: 1 });
    });
    writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
      d.byEntity.set(charId, {
        state: "surfaceRun", locomotionMode: "surfaceConstrained",
        profileId: "player", lastTransitionReason: "spawn", transitions: [],
        timeInState: 0, yawVel: 0, targetYaw: 0,
        bodyUpCurrent: [0, 0, 0, 1], bodyUpWorld: [0, 1, 0],
        orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      });
    });
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pivot.position).toEqual([3, 4, 5]);
  });

  it("leaves the camera buffer unchanged when no character is registered (e.g. Loading state)", () => {
    const { reg, graph } = setup();
    const camBuf = reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID);
    const before = readBuffer(camBuf);
    const beforePos = before.pivot.position.slice();
    tick(reg, graph);
    const after = readBuffer(camBuf);
    expect(after.pivot.position).toEqual(beforePos);
  });

  it("leaves pivot.up and pivot.fwd at their initial values (Phase 1: no gravity sampling yet)", () => {
    const { reg, graph } = setup();
    const charId = 1;
    writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
      d.byEntity.set(charId, { position: [0, 0, 0], yaw: 0, scale: 1 });
    });
    writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
      d.byEntity.set(charId, {
        state: "surfaceRun", locomotionMode: "surfaceConstrained",
        profileId: "player", lastTransitionReason: "spawn", transitions: [],
        timeInState: 0, yawVel: 0, targetYaw: 0,
        bodyUpCurrent: [0, 0, 0, 1], bodyUpWorld: [0, 1, 0],
        orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      });
    });
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pivot.up).toEqual([0, 1, 0]);
    expect(cam.pivot.fwd).toEqual([0, 0, -1]);
  });
});
