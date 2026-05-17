import { describe, it, expect } from "vitest";
import {
  pointInVolume,
  evaluateGravityField,
  pickGravity,
  sortVolumesByPriority,
  type GravityField,
  type GravityVolume,
  type GravityVolumeShape,
} from "../../../src/lib/math/gravityVolume";

describe("pointInVolume", () => {
  it("sphere contains origin and inside points; rejects outside", () => {
    const shape: GravityVolumeShape = { type: "sphere", center: [0, 0, 0], radius: 5 };
    expect(pointInVolume(shape, [0, 0, 0])).toBe(true);
    expect(pointInVolume(shape, [3, 0, 4])).toBe(true); // r=5 exactly
    expect(pointInVolume(shape, [3, 0, 4.001])).toBe(false);
    expect(pointInVolume(shape, [10, 0, 0])).toBe(false);
  });

  it("cylinder respects radius AND halfHeight along axis", () => {
    // Vertical cylinder of radius 2, halfHeight 3 at origin.
    const shape: GravityVolumeShape = {
      type: "cylinder",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      radius: 2,
      halfHeight: 3,
    };
    expect(pointInVolume(shape, [0, 0, 0])).toBe(true);
    expect(pointInVolume(shape, [1.9, 2.9, 0])).toBe(true);
    expect(pointInVolume(shape, [2.1, 0, 0])).toBe(false); // radius exceeded
    expect(pointInVolume(shape, [0, 3.1, 0])).toBe(false); // halfHeight exceeded
    expect(pointInVolume(shape, [0, -3, 0])).toBe(true); // boundary on negative side
  });

  it("aabb is inclusive on all faces", () => {
    const shape: GravityVolumeShape = { type: "aabb", min: [-1, -2, -3], max: [4, 5, 6] };
    expect(pointInVolume(shape, [0, 0, 0])).toBe(true);
    expect(pointInVolume(shape, [-1, -2, -3])).toBe(true);
    expect(pointInVolume(shape, [4, 5, 6])).toBe(true);
    expect(pointInVolume(shape, [4.001, 0, 0])).toBe(false);
    expect(pointInVolume(shape, [0, -2.001, 0])).toBe(false);
  });
});

describe("evaluateGravityField", () => {
  it("constant field returns the same vector everywhere", () => {
    const f: GravityField = { type: "constant", vector: [0, -9.81, 0] };
    expect(evaluateGravityField(f, [100, 50, -7])).toEqual([0, -9.81, 0]);
    expect(evaluateGravityField(f, [0, 0, 0])).toEqual([0, -9.81, 0]);
  });

  it("radial toward axis: gravity points from query toward axis", () => {
    // Vertical axis through origin. Query at (3, 1, 4) → radial offset (3, 0, 4),
    // r = 5, unit (0.6, 0, 0.8). "toward" → negate. magnitude 10 →
    //   gravity = (-0.6*10, 0, -0.8*10) = (-6, 0, -8).
    const f: GravityField = {
      type: "radial",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      direction: "toward",
      magnitude: 10,
    };
    const g = evaluateGravityField(f, [3, 1, 4]);
    expect(g[0]).toBeCloseTo(-6, 9);
    expect(g[1]).toBeCloseTo(0, 9);
    expect(g[2]).toBeCloseTo(-8, 9);
  });

  it("radial away from axis: gravity points outward", () => {
    const f: GravityField = {
      type: "radial",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      direction: "away",
      magnitude: 10,
    };
    const g = evaluateGravityField(f, [3, 1, 4]);
    expect(g[0]).toBeCloseTo(6, 9);
    expect(g[2]).toBeCloseTo(8, 9);
  });

  it("radial on axis returns zero (no direction)", () => {
    const f: GravityField = {
      type: "radial",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      direction: "toward",
      magnitude: 10,
    };
    const g = evaluateGravityField(f, [0, 5, 0]);
    expect(g).toEqual([0, 0, 0]);
  });

  it("radial with non-axis-aligned direction: project perpendicular component", () => {
    // Axis along +X. Query at (5, 3, 0): along-axis = 5, radial = (0, 3, 0), r=3, unit=(0,1,0).
    // toward, magnitude 6 → gravity = (0, -6, 0).
    const f: GravityField = {
      type: "radial",
      axisOrigin: [0, 0, 0],
      axisDirection: [1, 0, 0],
      direction: "toward",
      magnitude: 6,
    };
    const g = evaluateGravityField(f, [5, 3, 0]);
    expect(g[0]).toBeCloseTo(0, 9);
    expect(g[1]).toBeCloseTo(-6, 9);
    expect(g[2]).toBeCloseTo(0, 9);
  });

  it("point toward: gravity vector points from query toward centre (Mario-Galaxy sphere)", () => {
    const f: GravityField = {
      type: "point",
      center: [0, 0, 0],
      direction: "toward",
      magnitude: 10,
    };
    // Query at (3, 0, 4): r=5, unit = (3/5, 0, 4/5). toward → −10·unit = (−6, 0, −8).
    const g = evaluateGravityField(f, [3, 0, 4]);
    expect(g[0]).toBeCloseTo(-6, 9);
    expect(g[1]).toBeCloseTo(0, 9);
    expect(g[2]).toBeCloseTo(-8, 9);
  });

  it("point at centre: returns zero (no defined direction)", () => {
    const f: GravityField = {
      type: "point",
      center: [10, -3, 2],
      direction: "toward",
      magnitude: 9.81,
    };
    const g = evaluateGravityField(f, [10, -3, 2]);
    expect(g).toEqual([0, 0, 0]);
  });

  it("circle toward spine: gravity at a point above the spine pulls straight down onto it", () => {
    // Axis +Y, axisOrigin origin, major radius 8. Query directly above the spine
    // at (8, 5, 0): nearest spine point = (8, 0, 0). offset to spine = (0, -5, 0)
    // already at distance 5. toward → gravity unit = (0, -1, 0), magnitude 9.81.
    const f: GravityField = {
      type: "circle",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      majorRadius: 8,
      direction: "toward",
      magnitude: 9.81,
    };
    const g = evaluateGravityField(f, [8, 5, 0]);
    expect(g[0]).toBeCloseTo(0, 9);
    expect(g[1]).toBeCloseTo(-9.81, 9);
    expect(g[2]).toBeCloseTo(0, 9);
  });

  it("circle toward spine: gravity at a point outside the spine (in the same plane) pulls inward toward it", () => {
    // Axis +Y, axisOrigin origin, major radius 8. Query at (10, 0, 0) in the
    // spine plane. Nearest spine point = (8, 0, 0). offset = (-2, 0, 0).
    // toward → unit = (-1, 0, 0), magnitude 6.
    const f: GravityField = {
      type: "circle",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      majorRadius: 8,
      direction: "toward",
      magnitude: 6,
    };
    const g = evaluateGravityField(f, [10, 0, 0]);
    expect(g[0]).toBeCloseTo(-6, 9);
    expect(g[1]).toBeCloseTo(0, 9);
    expect(g[2]).toBeCloseTo(0, 9);
  });

  it("circle on axis: returns zero (radial direction undefined)", () => {
    const f: GravityField = {
      type: "circle",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      majorRadius: 8,
      direction: "toward",
      magnitude: 9.81,
    };
    const g = evaluateGravityField(f, [0, 3, 0]); // on the axis line
    expect(g).toEqual([0, 0, 0]);
  });
});

describe("pickGravity", () => {
  const universal: [number, number, number] = [0, -9.81, 0];
  const sphereVol: GravityVolume = {
    shape: { type: "sphere", center: [0, 0, 0], radius: 5 },
    field: { type: "constant", vector: [0, 0, 0] }, // zero-G inside
    priority: 0,
  };
  const aabbVol: GravityVolume = {
    shape: { type: "aabb", min: [-1, -1, -1], max: [1, 1, 1] },
    field: { type: "constant", vector: [99, 0, 0] }, // distinctive
    priority: 1, // higher
  };

  it("entity outside all volumes gets universal", () => {
    expect(pickGravity([sphereVol, aabbVol], universal, [100, 0, 0])).toEqual(universal);
  });

  it("entity inside one volume gets that volume's field", () => {
    expect(pickGravity([sphereVol], universal, [3, 0, 0])).toEqual([0, 0, 0]);
  });

  it("higher-priority volume wins when both contain the entity", () => {
    const sorted = sortVolumesByPriority([sphereVol, aabbVol]); // aabbVol (priority 1) first
    expect(pickGravity(sorted, universal, [0, 0, 0])).toEqual([99, 0, 0]);
  });
});
