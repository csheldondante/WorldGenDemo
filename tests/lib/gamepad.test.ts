import { describe, it, expect } from "vitest";
import {
  applyRadialDeadzone,
  snapshotGamepad,
  STANDARD_BUTTON_NAMES,
} from "../../src/lib/input/gamepad";

/**
 * Minimal fake Gamepad: only the fields snapshotGamepad reads.
 * Avoids depending on the lib.dom Gamepad type at the test boundary.
 */
type FakeGamepad = Pick<Gamepad, "axes" | "buttons">;

function fakePad(
  axes: readonly number[],
  pressedIndices: readonly number[] = [],
): FakeGamepad {
  const buttons = STANDARD_BUTTON_NAMES.map((_name, i) => ({
    pressed: pressedIndices.includes(i),
    touched: false,
    value: pressedIndices.includes(i) ? 1 : 0,
  })) as unknown as readonly GamepadButton[];
  return { axes: axes as readonly number[], buttons };
}

describe("applyRadialDeadzone", () => {
  it("zeros input inside the radial deadzone", () => {
    expect(applyRadialDeadzone(0.1, 0.05, 0.18)).toEqual({ x: 0, y: 0 });
  });

  it("returns zero on input exactly at the deadzone boundary", () => {
    const r = applyRadialDeadzone(0.18, 0, 0.18);
    expect(Math.hypot(r.x, r.y)).toBeCloseTo(0, 6);
  });

  it("rescales remainder so just-outside-deadzone is small, not full", () => {
    const r = applyRadialDeadzone(0.2, 0, 0.18);
    expect(r.x).toBeGreaterThan(0);
    expect(r.x).toBeLessThan(0.05);
    expect(r.y).toBeCloseTo(0, 6);
  });

  it("preserves direction and clamps magnitude to <=1 at full deflection", () => {
    const r = applyRadialDeadzone(1, 0, 0.18);
    expect(r.x).toBeCloseTo(1, 6);
    expect(r.y).toBeCloseTo(0, 6);
  });

  it("is rotationally symmetric (45-degree diagonal)", () => {
    const v = 0.5 / Math.SQRT2;
    const r = applyRadialDeadzone(v, v, 0.18);
    expect(r.x).toBeCloseTo(r.y, 6);
  });
});

describe("STANDARD_BUTTON_NAMES", () => {
  it("has 17 entries covering the W3C Standard Gamepad layout", () => {
    expect(STANDARD_BUTTON_NAMES.length).toBe(17);
  });

  it("button 0 is GamepadA and button 9 is GamepadStart", () => {
    expect(STANDARD_BUTTON_NAMES[0]).toBe("GamepadA");
    expect(STANDARD_BUTTON_NAMES[9]).toBe("GamepadStart");
  });
});

describe("snapshotGamepad", () => {
  it("returns deadzoned axes split into left/right stick", () => {
    const pad = fakePad([0.5, -0.7, -0.3, 0.9]);
    const snap = snapshotGamepad(pad as unknown as Gamepad, 0.18);
    expect(snap.axes.leftX).toBeGreaterThan(0);
    expect(snap.axes.leftY).toBeLessThan(0);
    expect(snap.axes.rightX).toBeLessThan(0);
    expect(snap.axes.rightY).toBeGreaterThan(0);
  });

  it("zeros sticks fully inside the deadzone", () => {
    const pad = fakePad([0.1, 0.1, -0.05, 0.05]);
    const snap = snapshotGamepad(pad as unknown as Gamepad, 0.18);
    expect(snap.axes.leftX).toBe(0);
    expect(snap.axes.leftY).toBe(0);
    expect(snap.axes.rightX).toBe(0);
    expect(snap.axes.rightY).toBe(0);
  });

  it("adds button names for pressed indices, omits unpressed", () => {
    const pad = fakePad([0, 0, 0, 0], [0, 9]); // A + Start
    const snap = snapshotGamepad(pad as unknown as Gamepad);
    expect(snap.buttons.has("GamepadA")).toBe(true);
    expect(snap.buttons.has("GamepadStart")).toBe(true);
    expect(snap.buttons.has("GamepadB")).toBe(false);
    expect(snap.buttons.size).toBe(2);
  });

  it("tolerates missing axes (no entries beyond rightY)", () => {
    const pad: FakeGamepad = { axes: [0.5, 0.5], buttons: [] as unknown as readonly GamepadButton[] };
    const snap = snapshotGamepad(pad as unknown as Gamepad);
    expect(snap.axes.rightX).toBe(0);
    expect(snap.axes.rightY).toBe(0);
    expect(snap.buttons.size).toBe(0);
  });
});
