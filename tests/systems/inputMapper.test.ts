import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { createInputBuffer, INPUT_BUFFER_ID, type InputBufferData } from "../../src/buffers/input";
import {
  createInputMapBuffer,
  INPUT_MAP_BUFFER_ID,
  type InputMapBufferData,
} from "../../src/buffers/inputMap";
import { createInputMapperSystem, INPUT_MAPPER_SYSTEM_ID } from "../../src/systems/inputMapper";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createInputBuffer());
  reg.registerBuffer(createInputMapBuffer());
  reg.registerSystem(createInputMapperSystem());
  const g = buildExecutionGraph({
    id: "g",
    nodes: [INPUT_MAPPER_SYSTEM_ID],
    registry: reg,
  });
  const input = reg.getBuffer<InputBufferData>(INPUT_BUFFER_ID);
  const map = reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID);
  return { reg, g, input, map };
}

function tick(
  reg: ReturnType<typeof createRegistry>,
  g: ReturnType<typeof buildExecutionGraph>,
  dt = 0.016,
) {
  executeGraph(g, reg, { dt, now: 0 });
}

describe("InputMapperSystem — move axis", () => {
  it("produces zero move with no input", () => {
    const { reg, g, map } = setup();
    tick(reg, g);
    const im = readBuffer(map);
    expect(im.moveAxis).toEqual({ x: 0, y: 0 });
  });

  it("KeyD alone → moveAxis.x = 1", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.keys = new Set(["KeyD"]); });
    tick(reg, g);
    expect(readBuffer(map).moveAxis.x).toBe(1);
  });

  it("left stick alone → moveAxis.x matches stick", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.gamepadAxes = { leftX: 0.5, leftY: 0, rightX: 0, rightY: 0 }; });
    tick(reg, g);
    expect(readBuffer(map).moveAxis.x).toBeCloseTo(0.5, 6);
  });

  it("KeyD + left stick clamps to 1, never overshoots", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => {
      d.keys = new Set(["KeyD"]);
      d.gamepadAxes = { leftX: 0.5, leftY: 0, rightX: 0, rightY: 0 };
    });
    tick(reg, g);
    expect(readBuffer(map).moveAxis.x).toBe(1);
  });

  it("inverts stick Y so stick-up = moveAxis.y positive (forward)", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.gamepadAxes = { leftX: 0, leftY: -0.7, rightX: 0, rightY: 0 }; });
    tick(reg, g);
    expect(readBuffer(map).moveAxis.y).toBeCloseTo(0.7, 6);
  });
});

describe("InputMapperSystem — look delta and mouse drain", () => {
  it("mouse dx → lookDelta.yaw (sign inverted, scaled by sens) and drains InputBuffer", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.mouseDx = 100; });
    tick(reg, g, 0.016);
    expect(readBuffer(map).lookDelta.yaw).toBeCloseTo(-100 * 0.0022, 6);
    expect(readBuffer(input).mouseDx).toBe(0);
    expect(readBuffer(input).mouseDy).toBe(0);
  });

  it("right stick X → lookDelta.yaw scales with dt", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.gamepadAxes = { leftX: 0, leftY: 0, rightX: 1, rightY: 0 }; });
    tick(reg, g, 0.1);
    // RIGHT_STICK_YAW_SPEED = 3.0 rad/s, sign inverted (right = yaw decreases)
    expect(readBuffer(map).lookDelta.yaw).toBeCloseTo(-0.3, 6);
  });

  it("right stick Y → lookDelta.pitch scales with dt", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.gamepadAxes = { leftX: 0, leftY: 0, rightX: 0, rightY: -1 }; });
    tick(reg, g, 0.1);
    // RIGHT_STICK_PITCH_SPEED = 2.2 rad/s; rightY=-1 (stick up) inverts to positive pitch
    expect(readBuffer(map).lookDelta.pitch).toBeCloseTo(0.22, 6);
  });

  it("mouse + right stick contributions sum in one frame", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => {
      d.mouseDx = 50;
      d.gamepadAxes = { leftX: 0, leftY: 0, rightX: 1, rightY: 0 };
    });
    tick(reg, g, 0.1);
    const expected = -50 * 0.0022 + -1 * 3.0 * 0.1;
    expect(readBuffer(map).lookDelta.yaw).toBeCloseTo(expected, 6);
  });
});

describe("InputMapperSystem — jump action edge detection", () => {
  it("Space first tick → pressed=true, held=true, heldSec=dt", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.keys = new Set(["Space"]); });
    tick(reg, g, 0.016);
    const j = readBuffer(map).actions.jump;
    expect(j).toEqual({ held: true, pressed: true, released: false, heldSec: 0.016 });
  });

  it("Space second tick → pressed=false, held=true, heldSec accumulates", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.keys = new Set(["Space"]); });
    tick(reg, g, 0.016);
    tick(reg, g, 0.016);
    const j = readBuffer(map).actions.jump;
    expect(j.held).toBe(true);
    expect(j.pressed).toBe(false);
    expect(j.heldSec).toBeCloseTo(0.032, 6);
  });

  it("release after hold → released=true, held=false, heldSec=0", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.keys = new Set(["Space"]); });
    tick(reg, g, 0.016);
    writeBuffer(input, (d) => { d.keys = new Set(); });
    tick(reg, g, 0.016);
    const j = readBuffer(map).actions.jump;
    expect(j).toEqual({ held: false, pressed: false, released: true, heldSec: 0 });
  });

  it("GamepadA alone (no keys) → equivalent to Space (held=true, pressed=true)", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => { d.gamepadButtons = new Set(["GamepadA"]); });
    tick(reg, g, 0.016);
    const j = readBuffer(map).actions.jump;
    expect(j.held).toBe(true);
    expect(j.pressed).toBe(true);
  });

  it("Space and GamepadA both held → still single held state, no double-counting", () => {
    const { reg, g, input, map } = setup();
    writeBuffer(input, (d) => {
      d.keys = new Set(["Space"]);
      d.gamepadButtons = new Set(["GamepadA"]);
    });
    tick(reg, g, 0.05);
    const j = readBuffer(map).actions.jump;
    expect(j.held).toBe(true);
    expect(j.pressed).toBe(true);
    expect(j.heldSec).toBeCloseTo(0.05, 6);
  });
});
