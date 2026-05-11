import { describe, it, expect } from "vitest";
import { identity, fromYaw, fromRotationVector, mul, rotate } from "../../../src/lib/math/quat";

const PI_2 = Math.PI / 2;

function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) < tol;
}

describe("quat.identity", () => {
  it("returns [0,0,0,1]", () => {
    expect(identity()).toEqual([0, 0, 0, 1]);
  });
});

describe("quat.fromYaw", () => {
  it("returns identity for zero yaw", () => {
    const q = fromYaw(0);
    expect(near(q[0], 0)).toBe(true);
    expect(near(q[1], 0)).toBe(true);
    expect(near(q[2], 0)).toBe(true);
    expect(near(q[3], 1)).toBe(true);
  });

  it("rotates a forward vector (0,0,-1) by +90° yaw to (-1,0,0)", () => {
    // Three.js Euler "YXZ" with positive yaw rotates the world counter-clockwise
    // about +Y as viewed from above. Forward (0,0,-1) becomes (-1,0,0).
    const q = fromYaw(PI_2);
    const v = rotate(q, [0, 0, -1]);
    expect(near(v[0], -1)).toBe(true);
    expect(near(v[1], 0)).toBe(true);
    expect(near(v[2], 0)).toBe(true);
  });

  it("leaves the Y axis unchanged at any yaw", () => {
    const q = fromYaw(1.23);
    const v = rotate(q, [0, 1, 0]);
    expect(near(v[0], 0)).toBe(true);
    expect(near(v[1], 1)).toBe(true);
    expect(near(v[2], 0)).toBe(true);
  });
});

describe("quat.mul", () => {
  it("identity * q === q", () => {
    const q = fromYaw(0.7);
    const r = mul(identity(), q);
    expect(near(r[0], q[0])).toBe(true);
    expect(near(r[1], q[1])).toBe(true);
    expect(near(r[2], q[2])).toBe(true);
    expect(near(r[3], q[3])).toBe(true);
  });

  it("yaw(a) * yaw(b) === yaw(a + b) (rotations about same axis compose)", () => {
    const a = fromYaw(0.4);
    const b = fromYaw(0.9);
    const ab = mul(a, b);
    const sum = fromYaw(1.3);
    expect(near(ab[0], sum[0])).toBe(true);
    expect(near(ab[1], sum[1])).toBe(true);
    expect(near(ab[2], sum[2])).toBe(true);
    expect(near(ab[3], sum[3])).toBe(true);
  });
});

describe("quat.fromRotationVector", () => {
  it("zero vector returns identity", () => {
    expect(fromRotationVector([0, 0, 0])).toEqual([0, 0, 0, 1]);
  });

  it("axis * 0 returns identity (handles tiny angles)", () => {
    const q = fromRotationVector([1e-12, 0, 0]);
    expect(q).toEqual([0, 0, 0, 1]);
  });

  it("matches fromYaw for a pure Y-axis rotation", () => {
    const angle = 0.5;
    const fromRv = fromRotationVector([0, angle, 0]);
    const fromY = fromYaw(angle);
    expect(near(fromRv[0], fromY[0])).toBe(true);
    expect(near(fromRv[1], fromY[1])).toBe(true);
    expect(near(fromRv[2], fromY[2])).toBe(true);
    expect(near(fromRv[3], fromY[3])).toBe(true);
  });

  it("rotation about +X by π/2 takes +Y to +Z", () => {
    const q = fromRotationVector([Math.PI / 2, 0, 0]);
    const v = rotate(q, [0, 1, 0]);
    expect(near(v[0], 0)).toBe(true);
    expect(near(v[1], 0)).toBe(true);
    expect(near(v[2], 1)).toBe(true);
  });

  it("preserves vector magnitude", () => {
    const q = fromRotationVector([0.3, 0.7, -0.2]);
    const v = rotate(q, [1, 2, 3]);
    expect(near(Math.hypot(v[0], v[1], v[2]), Math.hypot(1, 2, 3))).toBe(true);
  });
});

describe("quat.rotate", () => {
  it("identity leaves vector unchanged", () => {
    const v = rotate(identity(), [1, 2, 3]);
    expect(v).toEqual([1, 2, 3]);
  });

  it("composing rotation by mul matches sequential rotate", () => {
    const a = fromYaw(0.3);
    const b = fromYaw(0.8);
    const v: [number, number, number] = [1, 0, 0];

    const composed = rotate(mul(a, b), v);
    const sequential = rotate(a, rotate(b, v));

    expect(near(composed[0], sequential[0])).toBe(true);
    expect(near(composed[1], sequential[1])).toBe(true);
    expect(near(composed[2], sequential[2])).toBe(true);
  });
});
