import { describe, it, expect } from "vitest";
import {
  add,
  addScaled,
  basisPerpendicular,
  cross,
  dot,
  length,
  lengthSq,
  normalize,
  scale,
  sub,
} from "../../../src/lib/math/vec3";

describe("vec3 helpers", () => {
  it("dot product", () => {
    expect(dot([1, 2, 3], [4, -5, 6])).toBe(4 - 10 + 18);
    expect(dot([0, 0, 0], [1, 1, 1])).toBe(0);
  });

  it("cross product is right-handed", () => {
    // x × y = +z
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
    // y × z = +x
    expect(cross([0, 1, 0], [0, 0, 1])).toEqual([1, 0, 0]);
    // z × x = +y
    expect(cross([0, 0, 1], [1, 0, 0])).toEqual([0, 1, 0]);
  });

  it("add, sub, scale", () => {
    expect(add([1, 2, 3], [10, 20, 30])).toEqual([11, 22, 33]);
    expect(sub([5, 6, 7], [1, 2, 3])).toEqual([4, 4, 4]);
    expect(scale([1, -2, 3], 0.5)).toEqual([0.5, -1, 1.5]);
  });

  it("lengthSq and length", () => {
    expect(lengthSq([3, 4, 0])).toBe(25);
    expect(length([3, 4, 0])).toBe(5);
  });

  it("normalize returns unit vector", () => {
    const n = normalize([3, 4, 0]);
    expect(length(n)).toBeCloseTo(1, 9);
    expect(n[0]).toBeCloseTo(0.6, 9);
    expect(n[1]).toBeCloseTo(0.8, 9);
  });

  it("normalize of zero returns zero (not NaN)", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it("addScaled fuses add + scale", () => {
    expect(addScaled([1, 1, 1], [10, 20, 30], 0.5)).toEqual([6, 11, 16]);
  });

  describe("basisPerpendicular", () => {
    it("axis along +Z gives perpA along +Y, perpB along +X", () => {
      const { perpA, perpB } = basisPerpendicular([0, 0, 1]);
      // perpA should be world +Y component of ref([0,1,0]), since axis ⊥ Y → perpA = Y.
      expect(perpA[0]).toBeCloseTo(0, 9);
      expect(perpA[1]).toBeCloseTo(1, 9);
      expect(perpA[2]).toBeCloseTo(0, 9);
      // perpB = axis × perpA = Z × Y = -X. Right-handed convention: cross gives that.
      expect(perpB[0]).toBeCloseTo(-1, 9);
      expect(perpB[1]).toBeCloseTo(0, 9);
      expect(perpB[2]).toBeCloseTo(0, 9);
    });

    it("axis along +Y falls back to ref=+X", () => {
      const { perpA, perpB } = basisPerpendicular([0, 1, 0]);
      // perpA along +X (the fallback); perpB = Y × X = -Z
      expect(perpA[0]).toBeCloseTo(1, 9);
      expect(perpA[1]).toBeCloseTo(0, 9);
      expect(perpA[2]).toBeCloseTo(0, 9);
      expect(perpB[0]).toBeCloseTo(0, 9);
      expect(perpB[1]).toBeCloseTo(0, 9);
      expect(perpB[2]).toBeCloseTo(-1, 9);
    });

    it("axis along +X gives orthonormal basis perpendicular to it", () => {
      const { perpA, perpB } = basisPerpendicular([1, 0, 0]);
      // Both perp vectors should be perpendicular to axis and to each other, unit length
      expect(dot([1, 0, 0], perpA)).toBeCloseTo(0, 9);
      expect(dot([1, 0, 0], perpB)).toBeCloseTo(0, 9);
      expect(dot(perpA, perpB)).toBeCloseTo(0, 9);
      expect(length(perpA)).toBeCloseTo(1, 9);
      expect(length(perpB)).toBeCloseTo(1, 9);
    });

    it("perpA has a positive Y component (toward world up)", () => {
      // For a slanted axis, perpA should still pull "upward" as much as it can.
      const { perpA } = basisPerpendicular([1, 0, 1]); // 45° in XZ plane
      expect(perpA[1]).toBeGreaterThan(0.99); // should be very nearly world-up
    });
  });
});
