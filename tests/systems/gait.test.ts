import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  createVelocityBuffer,
  VELOCITY_BUFFER_ID,
  type VelocityBufferData,
} from "../../src/buffers/velocity";
import {
  createCharacterControllerBuffer,
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../../src/buffers/characterController";
import {
  createCharacterControllerProfileBuffer,
  DEFAULT_PLAYER_PROFILE,
} from "../../src/buffers/characterControllerProfile";
import { createGaitSystem, GAIT_SYSTEM_ID } from "../../src/systems/gait";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createVelocityBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerBuffer(createCharacterControllerProfileBuffer());
  reg.registerSystem(createGaitSystem());

  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
  const vel = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
  writeBuffer(cc, (d) => {
    d.byEntity.set(1, {
      state: "surfaceRun",
      locomotionMode: "surfaceConstrained",
      profileId: DEFAULT_PLAYER_PROFILE.id,
      lastTransitionReason: "spawn",
      timeInState: 0,
      yawVel: 0,
      gaitPhase: 0,
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
    });
  });
  writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, 0], prevLinear: [0, 0, 0] }); });

  const g = buildExecutionGraph({ id: "g", nodes: [GAIT_SYSTEM_ID], registry: reg });
  return { reg, g, cc, vel };
}

function tickN(
  reg: ReturnType<typeof createRegistry>,
  g: ReturnType<typeof buildExecutionGraph>,
  count: number,
  dt = 0.016,
) {
  for (let i = 0; i < count; i++) executeGraph(g, reg, { dt, now: i * dt });
}

describe("GaitSystem", () => {
  it("phase stays at 0 when speed is below gaitMinSpeed", () => {
    const { reg, g, cc } = setup();
    tickN(reg, g, 100);
    expect(readBuffer(cc).byEntity.get(1)!.gaitPhase).toBe(0);
  });

  it("phase advances at running speed and stays within [0, 2π)", () => {
    const { reg, g, cc, vel } = setup();
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, -8], prevLinear: [0, 0, -8] }); });
    tickN(reg, g, 30, 0.016);
    const phase = readBuffer(cc).byEntity.get(1)!.gaitPhase;
    expect(phase).toBeGreaterThan(0);
    expect(phase).toBeLessThan(Math.PI * 2);
  });

  it("faster speed → more phase per tick", () => {
    const { reg, g, cc, vel } = setup();
    const dt = 0.016;
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, -2], prevLinear: [0, 0, -2] }); });
    executeGraph(g, reg, { dt, now: 0 });
    const slowPhase = readBuffer(cc).byEntity.get(1)!.gaitPhase;
    writeBuffer(cc, (d) => {
      const c = d.byEntity.get(1)!;
      c.gaitPhase = 0;
      d.byEntity.set(1, c);
    });
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, -8], prevLinear: [0, 0, -8] }); });
    executeGraph(g, reg, { dt, now: 0 });
    const fastPhase = readBuffer(cc).byEntity.get(1)!.gaitPhase;
    expect(fastPhase).toBeGreaterThan(slowPhase);
  });

  it("phase wraps cleanly past 2π", () => {
    const { reg, g, cc, vel } = setup();
    writeBuffer(cc, (d) => {
      const c = d.byEntity.get(1)!;
      c.gaitPhase = Math.PI * 2 - 0.01; // just shy of wrap
      d.byEntity.set(1, c);
    });
    writeBuffer(vel, (d) => { d.byEntity.set(1, { linear: [0, 0, -8], prevLinear: [0, 0, -8] }); });
    // One tick at full speed should advance ≈ 2π·3·0.016 ≈ 0.30 rad — enough to cross the boundary.
    executeGraph(g, reg, { dt: 0.016, now: 0 });
    const phase = readBuffer(cc).byEntity.get(1)!.gaitPhase;
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThan(Math.PI * 2);
    expect(phase).toBeLessThan(0.5);
  });
});
