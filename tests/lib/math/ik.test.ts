import { describe, it, expect } from "vitest";
import { twoBoneIK, quatFromTo } from "../../../src/lib/math/ik";
import { rotate, mul, type Vec3 } from "../../../src/lib/math/quat";

function near(a: number, b: number, tol = 1e-4): boolean {
  return Math.abs(a - b) < tol;
}

describe("quatFromTo", () => {
  it("identity when vectors match", () => {
    expect(quatFromTo([0, -1, 0], [0, -1, 0])).toEqual([0, 0, 0, 1]);
  });

  it("rotation actually maps a → b for orthogonal vectors", () => {
    const q = quatFromTo([0, -1, 0], [1, 0, 0]);
    const r = rotate(q, [0, -1, 0]);
    expect(near(r[0], 1)).toBe(true);
    expect(near(r[1], 0)).toBe(true);
    expect(near(r[2], 0)).toBe(true);
  });

  it("handles opposite vectors without NaN", () => {
    const q = quatFromTo([0, -1, 0], [0, 1, 0]);
    const r = rotate(q, [0, -1, 0]);
    expect(near(r[0], 0)).toBe(true);
    expect(near(r[1], 1)).toBe(true);
    expect(near(r[2], 0)).toBe(true);
  });
});

describe("twoBoneIK — equal-length legs (L1=L2=0.4), rest [0,-1,0]", () => {
  const L1 = 0.4;
  const L2 = 0.4;
  const root: Vec3 = [0, 0, 0];
  const restDir: Vec3 = [0, -1, 0];
  const poleDir: Vec3 = [0, 0, -1]; // forward, knee bends forward

  it("near full reach → leg straightens (upper + lower compose to a near-straight chain)", () => {
    // Target just shy of L1+L2 so the IK isn't in the clamped over-reach branch.
    const { upper, lower } = twoBoneIK(root, [0, -0.79, 0], poleDir, L1, L2, restDir);
    const upperApplied = rotate(upper, restDir);
    expect(near(upperApplied[1], -1, 0.02)).toBe(true);
    const lowerWorld = rotate(mul(upper, lower), restDir);
    expect(near(lowerWorld[1], -1, 0.02)).toBe(true);
  });

  it("places the mid joint forward of straight-down when target is shorter and pole is forward", () => {
    // Target at (0,-0.6,0): D = 0.6 < L1+L2 = 0.8 → leg bends.
    const { midJoint } = twoBoneIK(root, [0, -0.6, 0], poleDir, L1, L2, restDir);
    expect(midJoint[2]).toBeLessThan(0); // knee forward (= -Z) per poleDir
    expect(midJoint[1]).toBeLessThan(0); // knee below the hip
  });

  it("clamps when target is past full reach (overReached = true)", () => {
    const { overReached, midJoint } = twoBoneIK(root, [0, -2, 0], poleDir, L1, L2, restDir);
    expect(overReached).toBe(true);
    // Mid joint should be on the straight line from root toward target, at distance L1.
    const dist = Math.hypot(midJoint[0], midJoint[1], midJoint[2]);
    expect(dist).toBeGreaterThan(0.39);
    expect(dist).toBeLessThan(0.41);
  });

  it("knee falls toward the pole side (forward pole → +X = 0 displacement, -Z knee)", () => {
    // With poleDir = (0, 0, -1), the knee should bend in the -Z direction.
    const { midJoint } = twoBoneIK(root, [0, -0.6, 0], [0, 0, -1], L1, L2, restDir);
    expect(midJoint[2]).toBeLessThan(-0.01);
    // Flip pole: knee should bend the other way.
    const { midJoint: mid2 } = twoBoneIK(root, [0, -0.6, 0], [0, 0, 1], L1, L2, restDir);
    expect(mid2[2]).toBeGreaterThan(0.01);
  });

  it("final pose places the lower bone's tip approximately at the target", () => {
    const target: Vec3 = [0, -0.5, -0.1];
    const { upper, lower, midJoint } = twoBoneIK(root, target, poleDir, L1, L2, restDir);
    // World direction of lower bone = compose upper · lower applied to restDir.
    const lowerWorld = rotate(mul(upper, lower), restDir);
    const tip: Vec3 = [
      midJoint[0] + L2 * lowerWorld[0],
      midJoint[1] + L2 * lowerWorld[1],
      midJoint[2] + L2 * lowerWorld[2],
    ];
    expect(near(tip[0], target[0], 0.01)).toBe(true);
    expect(near(tip[1], target[1], 0.01)).toBe(true);
    expect(near(tip[2], target[2], 0.01)).toBe(true);
  });
});
