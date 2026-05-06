import { describe, it, expect } from "vitest";
import { polygonArea, convexHull, principalAxes, orientedBoundingBox } from "../src/core/geom";

describe("polygonArea", () => {
  it("returns 0 for fewer than 3 points", () => {
    expect(polygonArea([])).toBe(0);
    expect(polygonArea([[0, 0]])).toBe(0);
    expect(polygonArea([[0, 0], [1, 1]])).toBe(0);
  });
  it("computes area of a unit square", () => {
    expect(polygonArea([[0, 0], [1, 0], [1, 1], [0, 1]])).toBeCloseTo(1, 10);
  });
  it("is invariant to winding order", () => {
    const ccw = polygonArea([[0, 0], [2, 0], [2, 1], [0, 1]]);
    const cw = polygonArea([[0, 1], [2, 1], [2, 0], [0, 0]]);
    expect(ccw).toBeCloseTo(2, 10);
    expect(cw).toBeCloseTo(2, 10);
  });
});

describe("convexHull", () => {
  it("of a square (with one interior point) is the four corners", () => {
    const hull = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
    expect(hull.length).toBe(4);
    // Hull includes all four corners
    const set = new Set(hull.map((p) => p.join(",")));
    expect(set.has("0,0")).toBe(true);
    expect(set.has("1,0")).toBe(true);
    expect(set.has("1,1")).toBe(true);
    expect(set.has("0,1")).toBe(true);
  });

  it("of collinear points is the endpoints", () => {
    const hull = convexHull([[0, 0], [1, 0], [2, 0], [3, 0]]);
    expect(hull.length).toBeLessThanOrEqual(2);
  });

  it("hull area equals area of bounding rectangle when input is a rectangle", () => {
    const hull = convexHull([[0, 0], [4, 0], [4, 2], [0, 2], [2, 1]]);
    expect(polygonArea(hull)).toBeCloseTo(8, 10);
  });
});

describe("principalAxes", () => {
  it("aligns with X for points spread along X", () => {
    const pts: [number, number][] = [];
    for (let i = -10; i <= 10; i++) pts.push([i, 0]);
    const { axisU } = principalAxes(pts);
    expect(Math.abs(axisU[0])).toBeCloseTo(1, 6);
    expect(Math.abs(axisU[1])).toBeCloseTo(0, 6);
  });
  it("aligns with diagonal for diagonal points", () => {
    const pts: [number, number][] = [];
    for (let i = -5; i <= 5; i++) pts.push([i, i]);
    const { axisU } = principalAxes(pts);
    // unit diagonal ~ (1/sqrt2, 1/sqrt2) up to sign
    expect(Math.abs(Math.abs(axisU[0]) - Math.abs(axisU[1]))).toBeLessThan(1e-3);
  });
});

describe("orientedBoundingBox", () => {
  it("matches AABB for axis-aligned points", () => {
    const pts: [number, number][] = [[0, 0], [4, 0], [4, 2], [0, 2]];
    const obb = orientedBoundingBox(pts);
    // halves should be 2 and 1 (in some order)
    const halves = [obb.halfU, obb.halfV].sort((a, b) => a - b);
    expect(halves[0]).toBeCloseTo(1, 6);
    expect(halves[1]).toBeCloseTo(2, 6);
    expect(obb.center[0]).toBeCloseTo(2, 6);
    expect(obb.center[1]).toBeCloseTo(1, 6);
  });

  it("aligns with rotated rectangle", () => {
    // 4x2 rectangle rotated 45 degrees
    const a = Math.PI / 4;
    const c = Math.cos(a), s = Math.sin(a);
    const corners: [number, number][] = ([
      [-2, -1], [2, -1], [2, 1], [-2, 1],
    ] as [number, number][]).map(([x, y]) => [x * c - y * s, x * s + y * c] as [number, number]);
    const obb = orientedBoundingBox(corners);
    const halves = [obb.halfU, obb.halfV].sort((a, b) => a - b);
    expect(halves[0]).toBeCloseTo(1, 4);
    expect(halves[1]).toBeCloseTo(2, 4);
    expect(obb.center[0]).toBeCloseTo(0, 4);
    expect(obb.center[1]).toBeCloseTo(0, 4);
  });
});
