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
  createInputMapBuffer,
  INPUT_MAP_BUFFER_ID,
  type InputMapBufferData,
} from "../../src/buffers/inputMap";
import {
  createCameraOrbitSystem,
  CAMERA_ORBIT_SYSTEM_ID,
} from "../../src/systems/cameraOrbit";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createCameraBuffer());
  reg.registerBuffer(createInputMapBuffer());
  reg.registerSystem(createCameraOrbitSystem());
  const graph = buildExecutionGraph({
    id: "test",
    nodes: [CAMERA_ORBIT_SYSTEM_ID],
    registry: reg,
  });
  return { reg, graph };
}

function tick(reg: ReturnType<typeof setup>["reg"], graph: ReturnType<typeof setup>["graph"]) {
  executeGraph(graph, reg, { now: 0, dt: 1 / 60, frame: 0 });
}

function setPivot(reg: ReturnType<typeof setup>["reg"], position: [number, number, number]) {
  writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
    d.pivot.position = position;
  });
}

function setLook(reg: ReturnType<typeof setup>["reg"], yaw: number, pitch: number) {
  writeBuffer(reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID), (d) => {
    d.lookDelta = { yaw, pitch };
  });
}

describe("cameraOrbitSystem (Phase 1)", () => {
  it("accumulates lookDelta into target.yaw and target.pitch", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    setLook(reg, 0.1, -0.05);
    tick(reg, graph);
    setLook(reg, 0.2, 0.03);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.yaw).toBeCloseTo(0.3, 12);
    expect(cam.target.pitch).toBeCloseTo(-0.02, 12);
    expect(cam.yaw).toBeCloseTo(cam.target.yaw, 12);
    expect(cam.pitch).toBeCloseTo(cam.target.pitch, 12);
  });

  it("clamps target pitch to ±(π/2 − 0.05) regardless of how hard the user pushes", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    setLook(reg, 0, 999);
    tick(reg, graph);
    const camUp = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(camUp.target.pitch).toBeCloseTo(Math.PI / 2 - 0.05, 12);

    setLook(reg, 0, -999);
    tick(reg, graph);
    const camDown = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(camDown.target.pitch).toBeCloseTo(-(Math.PI / 2 - 0.05), 12);
  });

  it("at yaw=0, pitch=0: camera sits at pivot + (0, 2.6, 6) — the legacy back-and-up offset", () => {
    const { reg, graph } = setup();
    setPivot(reg, [10, 0, 20]);
    // yaw=0, pitch=0; no look delta this tick.
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // fwd at yaw=0,pitch=0 is [0,0,-1]; pos = pivot - fwd*6 + [0, 2.6, 0]
    expect(cam.pos[0]).toBeCloseTo(10, 12);
    expect(cam.pos[1]).toBeCloseTo(2.6, 12);
    expect(cam.pos[2]).toBeCloseTo(26, 12);
  });

  it("at yaw=π/2, pitch=0: camera rotates 90° around pivot's vertical axis", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    // Set target.yaw=π/2 directly (rather than accumulating from lookDelta).
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.yaw = Math.PI / 2;
    });
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // At yaw=π/2: fwd = [-1, 0, 0]; pos = pivot - fwd*6 + [0, 2.6, 0] = (6, 2.6, 0)
    expect(cam.pos[0]).toBeCloseTo(6, 10);
    expect(cam.pos[1]).toBeCloseTo(2.6, 12);
    expect(cam.pos[2]).toBeCloseTo(0, 10);
  });
});
