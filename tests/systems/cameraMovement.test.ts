import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";

import { createInputBuffer } from "../../src/buffers/input";
import { createCameraBuffer, type CameraBufferData } from "../../src/buffers/camera";
import { createCameraMovementSystem } from "../../src/systems/cameraMovement";

function setup(initialCam?: Partial<CameraBufferData>) {
  const reg = createRegistry();
  const input = createInputBuffer();
  const camera = createCameraBuffer();
  if (initialCam) writeBuffer(camera, (d) => Object.assign(d, initialCam));
  reg.registerBuffer(input);
  reg.registerBuffer(camera);
  reg.registerSystem(createCameraMovementSystem());
  const g = buildExecutionGraph({ id: "g", nodes: ["cameraMovementSystem"], registry: reg });
  return { reg, input, camera, g };
}

function tick(reg: ReturnType<typeof createRegistry>, g: ReturnType<typeof buildExecutionGraph>, dt = 0.1) {
  executeGraph(g, reg, { dt, now: 0 });
}

describe("CameraMovementSystem", () => {
  it("KeyW at yaw=0 decreases pos.z (forward = -Z)", () => {
    const { reg, input, camera, g } = setup();
    writeBuffer(input, (d) => { d.keys = new Set(["KeyW"]); });
    const z0 = readBuffer(camera).pos[2];
    tick(reg, g);
    expect(readBuffer(camera).pos[2]).toBeLessThan(z0);
  });

  it("KeyD at yaw=0 increases pos.x (right = +X)", () => {
    const { reg, input, camera, g } = setup();
    writeBuffer(input, (d) => { d.keys = new Set(["KeyD"]); });
    const x0 = readBuffer(camera).pos[0];
    tick(reg, g);
    expect(readBuffer(camera).pos[0]).toBeGreaterThan(x0);
  });

  it("Space increases pos.y", () => {
    const { reg, input, camera, g } = setup();
    writeBuffer(input, (d) => { d.keys = new Set(["Space"]); });
    const y0 = readBuffer(camera).pos[1];
    tick(reg, g);
    expect(readBuffer(camera).pos[1]).toBeGreaterThan(y0);
  });

  it("WASD diagonals are normalized (no faster than cardinal)", () => {
    const { reg: r1, input: i1, camera: c1, g: g1 } = setup();
    writeBuffer(i1, (d) => { d.keys = new Set(["KeyW"]); });
    const z0a = readBuffer(c1).pos[2];
    tick(r1, g1, 0.1);
    const dForward = z0a - readBuffer(c1).pos[2];

    const { reg: r2, input: i2, camera: c2, g: g2 } = setup();
    writeBuffer(i2, (d) => { d.keys = new Set(["KeyW", "KeyD"]); });
    const x0 = readBuffer(c2).pos[0];
    const z0 = readBuffer(c2).pos[2];
    tick(r2, g2, 0.1);
    const dx = readBuffer(c2).pos[0] - x0;
    const dz = z0 - readBuffer(c2).pos[2];
    const diag = Math.hypot(dx, dz);
    expect(diag).toBeCloseTo(dForward, 3);
  });

  it("mouse deltas update yaw and pitch and are then drained", () => {
    const { reg, input, camera, g } = setup();
    const yaw0 = readBuffer(camera).yaw;
    const pitch0 = readBuffer(camera).pitch;
    writeBuffer(input, (d) => { d.mouseDx = 100; d.mouseDy = 50; });
    tick(reg, g);
    expect(readBuffer(camera).yaw).not.toBe(yaw0);
    expect(readBuffer(camera).pitch).not.toBe(pitch0);
    // Deltas are drained after consumption
    expect(readBuffer(input).mouseDx).toBe(0);
    expect(readBuffer(input).mouseDy).toBe(0);
  });

  it("pitch is clamped within ~±π/2", () => {
    const { reg, input, camera, g } = setup();
    for (let i = 0; i < 100; i++) {
      writeBuffer(input, (d) => { d.mouseDy = -1000; });
      tick(reg, g);
    }
    const p = readBuffer(camera).pitch;
    expect(p).toBeLessThanOrEqual(Math.PI / 2);
    expect(p).toBeGreaterThanOrEqual(-Math.PI / 2);
  });

  it("Shift boosts speed", () => {
    const { reg: r1, input: i1, camera: c1, g: g1 } = setup();
    writeBuffer(i1, (d) => { d.keys = new Set(["KeyW"]); });
    const z0a = readBuffer(c1).pos[2];
    tick(r1, g1, 0.1);
    const dNormal = z0a - readBuffer(c1).pos[2];

    const { reg: r2, input: i2, camera: c2, g: g2 } = setup();
    writeBuffer(i2, (d) => { d.keys = new Set(["KeyW", "ShiftLeft"]); });
    const z0b = readBuffer(c2).pos[2];
    tick(r2, g2, 0.1);
    const dBoost = z0b - readBuffer(c2).pos[2];
    expect(dBoost).toBeGreaterThan(dNormal);
  });
});
