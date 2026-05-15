import { describe, it, expect } from "vitest";
import { evaluateLinearAccel, xInterceptShifted, type LinearAccelCurve } from "../../../src/lib/math/accelCurve";

describe("evaluateLinearAccel", () => {
  const curve: LinearAccelCurve = { accelAtZero: 40, vMax: 8 };

  it("returns accelAtZero at v=0", () => {
    expect(evaluateLinearAccel(curve, 0)).toBe(40);
  });

  it("returns 0 at v=vMax", () => {
    expect(evaluateLinearAccel(curve, 8)).toBe(0);
  });

  it("returns accelAtZero/2 at v=vMax/2 (linear interpolation)", () => {
    expect(evaluateLinearAccel(curve, 4)).toBeCloseTo(20, 10);
  });

  it("clamps to accelAtZero for v<0 (moving against the curve direction)", () => {
    expect(evaluateLinearAccel(curve, -5)).toBe(40);
  });

  it("returns NEGATIVE for v > vMax (limbs drag past sustainable speed) — no upper clamp", () => {
    // accelAtZero · (1 − v/vMax) = 40 · (1 − 12/8) = 40 · −0.5 = −20.
    expect(evaluateLinearAccel(curve, 12)).toBeCloseTo(-20, 10);
    expect(evaluateLinearAccel(curve, 16)).toBeCloseTo(-40, 10);
  });

  it("interpolates correctly at arbitrary intermediate v", () => {
    expect(evaluateLinearAccel(curve, 2)).toBeCloseTo(30, 10);
    expect(evaluateLinearAccel(curve, 6)).toBeCloseTo(10, 10);
    expect(evaluateLinearAccel(curve, 7)).toBeCloseTo(5, 10);
  });

  it("zero-vMax curve: accelAtZero at v=0, −Infinity for any positive v", () => {
    // Edge case: vMax = 0 is degenerate (division by zero in the linear form).
    // At v=0 returns accelAtZero. For v>0 the formula yields −Infinity (the
    // limit of "limbs can't produce any thrust at all" past zero). Callers that
    // care about this edge case should set vMax to a small positive value or
    // Infinity instead.
    const c: LinearAccelCurve = { accelAtZero: 5, vMax: 0 };
    expect(evaluateLinearAccel(c, 0)).toBe(5);
    expect(evaluateLinearAccel(c, 0.01)).toBe(Number.NEGATIVE_INFINITY);
  });

  it("supports Infinity vMax as a constant cap (for migration from scalar fields)", () => {
    // Setting vMax = Infinity makes the curve a constant — `evaluate(v) = accelAtZero`
    // for all v >= 0. Useful when promoting a scalar field to a curve without
    // changing behavior, until we have data to pick a real vMax.
    const c: LinearAccelCurve = { accelAtZero: 25, vMax: Infinity };
    expect(evaluateLinearAccel(c, 0)).toBe(25);
    expect(evaluateLinearAccel(c, 100)).toBe(25);
    expect(evaluateLinearAccel(c, 1e9)).toBe(25);
  });
});

describe("xInterceptShifted", () => {
  const fwd: LinearAccelCurve = { accelAtZero: 40, vMax: 8 };

  it("with no external accel returns vMax", () => {
    expect(xInterceptShifted(fwd, 0)).toBe(8);
  });

  it("with positive external accel (tailwind / downhill) shifts x-intercept right", () => {
    // 8 · (1 + 5/40) = 8 · 1.125 = 9
    expect(xInterceptShifted(fwd, 5)).toBeCloseTo(9, 10);
    // 8 · (1 + 40/40) = 16
    expect(xInterceptShifted(fwd, 40)).toBeCloseTo(16, 10);
  });

  it("with negative external accel (headwind / uphill) shifts x-intercept left", () => {
    // 8 · (1 - 5/40) = 8 · 0.875 = 7
    expect(xInterceptShifted(fwd, -5)).toBeCloseTo(7, 10);
    // 8 · (1 - 20/40) = 4
    expect(xInterceptShifted(fwd, -20)).toBeCloseTo(4, 10);
  });

  it("clamps to 0 when external opposition is so strong that x-intercept would be negative", () => {
    // 8 · (1 - 50/40) = 8 · -0.25 = -2 → clamped to 0
    expect(xInterceptShifted(fwd, -50)).toBe(0);
  });

  it("returns +Infinity when vMax is Infinity (the constant-curve migration case)", () => {
    const constCurve: LinearAccelCurve = { accelAtZero: 5, vMax: Infinity };
    expect(xInterceptShifted(constCurve, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(xInterceptShifted(constCurve, -100)).toBe(Number.POSITIVE_INFINITY);
  });
});
