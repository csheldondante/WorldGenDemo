import { describe, it, expect } from "vitest";
import { solveBodyUpTarget } from "../../../src/lib/math/leanSolver";
import type { Vec3 } from "../../../src/lib/math/quat";

const G: Vec3 = [0, -9.81, 0];

function near(a: number, b: number, tol = 1e-4): boolean {
  return Math.abs(a - b) < tol;
}

describe("solveBodyUpTarget — flat ground", () => {
  const flatN: Vec3 = [0, 1, 0];

  it("zero velocity + zero accel + zero drag → body up = world up", () => {
    const { bodyUpTarget, leanAngle } = solveBodyUpTarget({
      velocity: [0, 0, 0],
      accelReal: [0, 0, 0],
      surfaceNormal: flatN,
      gravity: G,
      dragCoeff: 0,
    });
    expect(bodyUpTarget[0]).toBeCloseTo(0, 6);
    expect(bodyUpTarget[1]).toBeCloseTo(1, 6);
    expect(bodyUpTarget[2]).toBeCloseTo(0, 6);
    expect(leanAngle).toBeCloseTo(0, 6);
  });

  it("forward velocity + drag → body tips forward", () => {
    const { bodyUpTarget, leanAngle, tangentAccel } = solveBodyUpTarget({
      velocity: [0, 0, -8],          // moving in -Z (forward)
      accelReal: [0, 0, 0],
      surfaceNormal: flatN,
      gravity: G,
      dragCoeff: 0.5,                // gives a_eff_drag = -4 m/s² Z
    });
    // a_tangent is along -Z (forward). apparentG = (0, -g, 0) − (0,0,-4)
    //   = (0, -g, +4). −apparentG = (0, g, -4). Normalized → forward-tilted up.
    expect(tangentAccel[2]).toBeCloseTo(-4, 4);
    expect(bodyUpTarget[2]).toBeLessThan(-0.1); // up vector tipped in -Z (forward)
    expect(bodyUpTarget[1]).toBeGreaterThan(0.85);
    // Lean angle = atan(4/9.81) ≈ 0.39 rad
    expect(near(leanAngle, Math.atan2(4, 9.81), 1e-3)).toBe(true);
  });

  it("forward acceleration without drag → body tips forward proportionally", () => {
    const { bodyUpTarget, leanAngle } = solveBodyUpTarget({
      velocity: [0, 0, 0],
      accelReal: [0, 0, -9.81],      // 1g forward accel
      surfaceNormal: flatN,
      gravity: G,
      dragCoeff: 0,
    });
    // tan(θ) = 9.81/9.81 = 1 → θ = π/4. Up tips ~45° forward.
    expect(near(leanAngle, Math.PI / 4, 1e-3)).toBe(true);
    expect(bodyUpTarget[1]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(bodyUpTarget[2]).toBeCloseTo(-Math.SQRT1_2, 3);
  });

  it("rightward acceleration → body banks to the right (+X)", () => {
    const { bodyUpTarget, leanAngle } = solveBodyUpTarget({
      velocity: [0, 0, 0],
      accelReal: [9.81, 0, 0],
      surfaceNormal: flatN,
      gravity: G,
      dragCoeff: 0,
    });
    expect(near(leanAngle, Math.PI / 4, 1e-3)).toBe(true);
    expect(bodyUpTarget[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(bodyUpTarget[1]).toBeCloseTo(Math.SQRT1_2, 3);
  });

  it("backward acceleration (braking from forward velocity) → body tips backward (+Z)", () => {
    const { bodyUpTarget } = solveBodyUpTarget({
      velocity: [0, 0, -4],
      accelReal: [0, 0, +9.81],
      surfaceNormal: flatN,
      gravity: G,
      dragCoeff: 0.5,                // drag adds -2 m/s² along Z; net a_eff.z = +7.81
    });
    expect(bodyUpTarget[2]).toBeGreaterThan(0.1); // up tipped in +Z (backward)
  });
});

describe("solveBodyUpTarget — slope", () => {
  // 30° slope where +X is uphill: surface normal tilts toward −X.
  const slope30: Vec3 = [-Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0];

  it("standing still on a slope with no accel → body up = world up (vertical biped)", () => {
    // Real bipeds on a slope keep their torso vertical (CoM over feet via leg
    // adjustment), not parallel to the slope. The apparent-gravity model
    // captures this: at rest, apparentG = gravity (a_tangent = 0), so bodyUp
    // = world up regardless of the surface tilt.
    const { bodyUpTarget } = solveBodyUpTarget({
      velocity: [0, 0, 0],
      accelReal: [0, 0, 0],
      surfaceNormal: slope30,
      gravity: G,
      dragCoeff: 0,
    });
    expect(bodyUpTarget[0]).toBeCloseTo(0, 4);
    expect(bodyUpTarget[1]).toBeCloseTo(1, 4);
    expect(bodyUpTarget[2]).toBeCloseTo(0, 4);
  });

  it("accelerating uphill (+X on this slope) tips the body uphill (head forward of feet)", () => {
    // Sprinter accelerating up a slope: CoM/head leans in the direction of
    // motion so the feet can push back. With acceleration in +X (uphill on
    // this slope), bodyUp's +X component goes positive.
    const aMag = 9.81 * Math.sin(Math.PI / 6); // ~4.9 m/s²
    const { bodyUpTarget } = solveBodyUpTarget({
      velocity: [0, 0, 0],
      accelReal: [aMag, 0, 0],
      surfaceNormal: slope30,
      gravity: G,
      dragCoeff: 0,
    });
    expect(bodyUpTarget[0]).toBeGreaterThan(0.1);
    expect(bodyUpTarget[1]).toBeGreaterThan(0.85);
  });
});

describe("solveBodyUpTarget — edge cases", () => {
  it("degenerate apparent gravity (g cancelled) falls back to surface normal", () => {
    const N: Vec3 = [0, 1, 0];
    const { bodyUpTarget } = solveBodyUpTarget({
      velocity: [0, 0, 0],
      // accel exactly cancels gravity → apparentGravity = 0 → fallback.
      accelReal: [0, 9.81, 0],
      surfaceNormal: N,
      gravity: G,
      dragCoeff: 0,
    });
    expect(bodyUpTarget[1]).toBeGreaterThan(0.99);
  });
});
