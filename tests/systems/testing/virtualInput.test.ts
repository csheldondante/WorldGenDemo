/**
 * Tests for the virtual input system. Exercises the real input → inputMapper
 * pipeline end-to-end against scripted device state — proving that gameplay
 * tests can drive the controller via the same chain a real player would use
 * (keys → InputBuffer → InputMapBuffer.actions → CharacterInputBuffer).
 */
import { describe, it, expect } from "vitest";
import { createRegistry } from "../../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../../src/runtime/buffer";
import { buildExecutionGraph } from "../../../src/runtime/graph";
import { executeGraph } from "../../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../../src/buffers";
import { INPUT_BUFFER_ID, type InputBufferData } from "../../../src/buffers/input";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../../../src/buffers/inputMap";
import { CHARACTER_INPUT_BUFFER_ID, type CharacterInputBufferData } from "../../../src/buffers/characterInput";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../../../src/buffers/characterController";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../../../src/buffers/camera";
import { DEFAULT_PLAYER_PROFILE } from "../../../src/buffers/characterControllerProfile";
import { createInputMapperSystem } from "../../../src/systems/inputMapper";
import { createCharacterInputSystem } from "../../../src/systems/characterInput";
import { createVirtualInput, createVirtualInputSystem } from "../../../src/systems/testing/virtualInput";

describe("Virtual input system", () => {
  function setup() {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    const vi = createVirtualInput();
    reg.registerSystem(createVirtualInputSystem(vi));
    reg.registerSystem(createInputMapperSystem());
    reg.registerSystem(createCharacterInputSystem());

    // Seed a character entity so characterInputSystem has someone to write for.
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
      desiredFacingTangent: [0, 0, -1],
      jumpHolding: false,
      jumpDir: [0, 0, 0],
      jumpImpulseMagMax: 0,
      jumpImpulseApplied: 0,
      });
    });
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.yaw = Math.PI;
    });

    const g = buildExecutionGraph({
      id: "vi-test",
      nodes: ["scriptedInputSystem", "inputMapperSystem", "characterInputSystem"],
      registry: reg,
    });
    return { reg, vi, g, id };
  }

  function tick(reg: ReturnType<typeof createRegistry>, g: ReturnType<typeof buildExecutionGraph>, dt = 0.016): void {
    executeGraph(g, reg, { dt, now: 0 });
  }

  it("pressing KeyW drives moveY = 1 down to CharacterInputBuffer", () => {
    const { reg, vi, g, id } = setup();
    vi.keys.add("KeyW");
    tick(reg, g);

    const input = readBuffer(reg.getBuffer<InputBufferData>(INPUT_BUFFER_ID));
    expect(input.keys.has("KeyW")).toBe(true);

    const im = readBuffer(reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
    expect(im.moveAxis.y).toBe(1);
    expect(im.moveAxis.x).toBe(0);

    const ci = readBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID)).byEntity.get(id)!;
    expect(ci.moveY).toBe(1);
    expect(ci.moveX).toBe(0);
    expect(ci.cameraYaw).toBe(Math.PI);
  });

  it("pressing KeyA and KeyW together gives a unit-length diagonal move axis", () => {
    const { reg, vi, g, id } = setup();
    vi.keys.add("KeyA");
    vi.keys.add("KeyW");
    tick(reg, g);

    // Raw key contributions are (-1, 1) → magnitude √2. inputMapper
    // normalizes vectors with |v|>1 so diagonals aren't faster than straight.
    const ci = readBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID)).byEntity.get(id)!;
    const inv = 1 / Math.SQRT2;
    expect(ci.moveX).toBeCloseTo(-inv, 12);
    expect(ci.moveY).toBeCloseTo(inv, 12);
    expect(Math.hypot(ci.moveX, ci.moveY)).toBeCloseTo(1, 12);
  });

  it("Space press → InputMapBuffer.actions.jump.pressed=true on the press tick, then held=true after", () => {
    const { reg, vi, g, id } = setup();
    // Tick 1: Space pressed (edge)
    vi.keys.add("Space");
    tick(reg, g);
    let ci = readBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID)).byEntity.get(id)!;
    expect(ci.jumpPressed).toBe(true);
    expect(ci.jumpHeld).toBe(true);

    // Tick 2: still holding — pressed edge gone, held remains
    tick(reg, g);
    ci = readBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID)).byEntity.get(id)!;
    expect(ci.jumpPressed).toBe(false);
    expect(ci.jumpHeld).toBe(true);

    // Tick 3: release — released edge, held false
    vi.keys.delete("Space");
    tick(reg, g);
    ci = readBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID)).byEntity.get(id)!;
    expect(ci.jumpReleased).toBe(true);
    expect(ci.jumpHeld).toBe(false);
  });

  it("mouse delta written one tick is consumed and cleared", () => {
    const { reg, vi, g } = setup();
    vi.mouseDx = 100;
    vi.mouseDy = 50;
    tick(reg, g);

    // After the tick, the virtual state's deltas are zeroed.
    expect(vi.mouseDx).toBe(0);
    expect(vi.mouseDy).toBe(0);

    // The InputMapBuffer should have processed them into lookDelta (negated by mapper convention).
    // We don't assert exact values here — InputMapper.test.ts owns that — only that the chain ran.
    const im = readBuffer(reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
    expect(typeof im.lookDelta.yaw).toBe("number");
  });

  it("gamepad axes are copied through to InputMapBuffer.moveAxis", () => {
    const { reg, vi, g, id } = setup();
    vi.gamepadConnected = true;
    vi.gamepadAxes = { leftX: 0.5, leftY: -0.7, rightX: 0, rightY: 0 };
    tick(reg, g);

    const ci = readBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID)).byEntity.get(id)!;
    // The mapper inverts gamepad Y so stick-up = forward (moveY positive).
    expect(ci.moveX).toBeCloseTo(0.5);
    expect(ci.moveY).toBeCloseTo(0.7);
  });
});
