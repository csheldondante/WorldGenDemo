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
  executeGraph(graph, reg, { now: 0, dt: 1 / 60 });
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

describe("cameraOrbitSystem (Phase 2 spherical orbit around pivot.up)", () => {
  it("accumulates lookDelta.yaw into target.yaw; FLIPS lookDelta.pitch sign so mouse-down (negative lookDelta.pitch) lifts the camera", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    // Reset target.pitch so it doesn't start at the buffer default.
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.pitch = 0;
    });
    setLook(reg, 0.1, -0.05);  // mouseDx>0 → yaw=0.1; mouseDy>0 → lookDelta.pitch=-0.05
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.yaw).toBeCloseTo(0.1, 12);
    // target.pitch = 0 - (-0.05) = +0.05 → camera lifted ABOVE pivot
    expect(cam.target.pitch).toBeCloseTo(0.05, 12);
  });

  it("hard-clamps target.pitch to params.pitchMin / pitchMax (Phase 2 — no cushion yet)", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    // Huge negative lookDelta.pitch → mouse pushed UP → target.pitch decreases.
    setLook(reg, 0, 999);
    tick(reg, graph);
    let cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.pitch).toBeCloseTo(cam.params.pitchMin, 12);
    // Huge positive lookDelta.pitch → mouse pushed DOWN → target.pitch rises.
    setLook(reg, 0, -999);
    tick(reg, graph);
    cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.pitch).toBeCloseTo(cam.params.pitchMax, 12);
  });

  it("at flat gravity (up=+Y, fwd=-Z), yaw=0 pitch=atan(2.6/6), distance=√(6²+2.6²): camera matches the legacy (0, 2.6, 6) offset", () => {
    const { reg, graph } = setup();
    setPivot(reg, [10, 0, 20]);
    // Buffer defaults already set target.pitch = atan(2.6/6), distance = √(6²+2.6²).
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pos[0]).toBeCloseTo(10, 9);
    expect(cam.pos[1]).toBeCloseTo(2.6, 9);
    expect(cam.pos[2]).toBeCloseTo(26, 9);
  });

  it("at flat gravity with yaw=π/2: camera rotates 90° around pivot.up to +X side (matches legacy YXZ Euler convention)", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.yaw = Math.PI / 2;
      d.target.pitch = 0;       // horizon-level — needs the pitch-min floor relaxed
      d.params.distance = 6;
      d.params.pitchMin = -1;   // disable hard floor for this strict geometry test
    });
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pos[0]).toBeCloseTo(6, 9);
    expect(cam.pos[1]).toBeCloseTo(0, 9);
    expect(cam.pos[2]).toBeCloseTo(0, 9);
  });

  it("on a side-pivoted up (e.g. cylinder side: up=+X), camera elevates in the +X direction with positive pitch", () => {
    const { reg, graph } = setup();
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.pivot.position = [0, 0, 0];
      d.pivot.up = [1, 0, 0];
      d.pivot.fwd = [0, 0, -1];   // ⊥ up, parallel-transported
      d.target.yaw = 0;
      d.target.pitch = Math.PI / 4;  // 45° elevation
      d.params.distance = 6;
    });
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // pos = pivot + (-yawedFwd·cos(p) + up·sin(p))·D
    // yawedFwd = fwd at yaw=0 = (0,0,-1); -yawedFwd = (0,0,1)
    // up·sin(45°) = (sin45, 0, 0); cos(45°) = √2/2
    // pos = 0 + ((0,0,√2/2) + (√2/2, 0, 0))·6 = (3√2, 0, 3√2) ≈ (4.243, 0, 4.243)
    const expected = 6 * Math.SQRT2 / 2;
    expect(cam.pos[0]).toBeCloseTo(expected, 9);
    expect(cam.pos[1]).toBeCloseTo(0, 9);
    expect(cam.pos[2]).toBeCloseTo(expected, 9);
  });

  it("derives renderer-facing yaw/pitch (YXZ Euler around world axes) from the world-space view direction", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.yaw = 0;
      d.target.pitch = Math.atan2(2.6, 6);  // back to default
      d.params.distance = Math.hypot(6, 2.6);
    });
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // Camera at (0, 2.6, 6) looking at origin → view direction (0, -2.6, -6)/dist.
    // YXZ Euler: world_pitch = asin(view.y) = asin(-2.6/dist) ≈ -0.409.
    // world_yaw = atan2(-view.x, -view.z) = atan2(0, 6/dist) = 0.
    expect(cam.pitch).toBeCloseTo(-Math.atan2(2.6, 6), 9);
    expect(cam.yaw).toBeCloseTo(0, 9);
  });
});
