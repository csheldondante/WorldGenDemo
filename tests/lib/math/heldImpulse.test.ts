import { describe, it, expect } from "vitest";
import { heldImpulseProgress } from "../../../src/lib/math/heldImpulse";

describe("heldImpulseProgress (continuous)", () => {
  it("returns 0 at t=0", () => {
    expect(heldImpulseProgress(0, 1.0, 1)).toBe(0);
  });

  it("returns linear fraction within the window", () => {
    expect(heldImpulseProgress(0.25, 1.0, 1)).toBe(0.25);
    expect(heldImpulseProgress(0.5, 1.0, 1)).toBe(0.5);
    expect(heldImpulseProgress(0.9, 1.0, 1)).toBe(0.9);
  });

  it("clamps to 1 past the window", () => {
    expect(heldImpulseProgress(1.0, 1.0, 1)).toBe(1);
    expect(heldImpulseProgress(2.0, 1.0, 1)).toBe(1);
  });

  it("clamps to 0 for negative t", () => {
    expect(heldImpulseProgress(-1, 1.0, 1)).toBe(0);
  });

  it("degenerate holdMaxSec=0 → 1", () => {
    expect(heldImpulseProgress(0, 0, 1)).toBe(1);
    expect(heldImpulseProgress(0.5, 0, 1)).toBe(1);
  });
});

describe("heldImpulseProgress (stepped)", () => {
  it("step 1 fires at t=0+ and remains 1/N until the next boundary", () => {
    // holdMaxSec=1, stepCount=4 → step boundaries at t = {0, 0.25, 0.5, 0.75, 1.0}.
    // Step idx in [0, 0.25) is 1 → progress = 0.25.
    expect(heldImpulseProgress(0, 1.0, 4)).toBe(0.25);
    expect(heldImpulseProgress(0.001, 1.0, 4)).toBe(0.25);
    expect(heldImpulseProgress(0.249, 1.0, 4)).toBe(0.25);
  });

  it("crosses to step 2 at t=holdMax/N", () => {
    expect(heldImpulseProgress(0.25, 1.0, 4)).toBe(0.5);
    expect(heldImpulseProgress(0.4, 1.0, 4)).toBe(0.5);
  });

  it("crosses to step 3 at t=2*holdMax/N", () => {
    expect(heldImpulseProgress(0.5, 1.0, 4)).toBe(0.75);
    expect(heldImpulseProgress(0.6, 1.0, 4)).toBe(0.75);
  });

  it("crosses to step 4 (full) at t=3*holdMax/N", () => {
    expect(heldImpulseProgress(0.75, 1.0, 4)).toBe(1);
    expect(heldImpulseProgress(0.99, 1.0, 4)).toBe(1);
  });

  it("clamps to 1 past the window", () => {
    expect(heldImpulseProgress(1.5, 1.0, 4)).toBe(1);
    expect(heldImpulseProgress(10, 1.0, 4)).toBe(1);
  });

  it("stepCount=2 → halves", () => {
    expect(heldImpulseProgress(0, 1.0, 2)).toBe(0.5);
    expect(heldImpulseProgress(0.49, 1.0, 2)).toBe(0.5);
    expect(heldImpulseProgress(0.5, 1.0, 2)).toBe(1);
  });
});

describe("heldImpulseProgress (frame-rate independence)", () => {
  it("same elapsed time produces same progress regardless of accumulation pattern", () => {
    // Stepped or continuous, progress only depends on tHeld, not how it was reached.
    const reached0p3_by_steps = [0.1, 0.1, 0.1].reduce((s, d) => s + d, 0);
    const reached0p3_directly = 0.3;
    expect(heldImpulseProgress(reached0p3_by_steps, 1.0, 4))
      .toBeCloseTo(heldImpulseProgress(reached0p3_directly, 1.0, 4), 6);
    expect(heldImpulseProgress(reached0p3_by_steps, 1.0, 1))
      .toBeCloseTo(heldImpulseProgress(reached0p3_directly, 1.0, 1), 6);
  });
});
