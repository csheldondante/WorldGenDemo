import { describe, it, expect } from "vitest";
import {
  CylindricalSurfaceProvider,
  PlaneSurfaceProvider,
  TorusSurfaceProvider,
} from "../../src/world/parametricSurfaceProvider";
import { dot, length } from "../../src/lib/math/vec3";

const TWO_PI_SQ = (2 * Math.PI) * (2 * Math.PI);

// ---------------------------------------------------------------------------
// PlaneSurfaceProvider
// ---------------------------------------------------------------------------

describe("PlaneSurfaceProvider — flat horizontal plane", () => {
  const plane = new PlaneSurfaceProvider({
    id: "plane",
    origin: [-10, 5, -10],     // 20×20 patch centered at world origin XZ, sitting at y=5
    extentU: [20, 0, 0],
    extentV: [0, 0, 20],
  });

  it("normal is world +Y, slope is 0", () => {
    const s = plane.sampleAtUV(0.5, 0.5);
    expect(s.normal[1]).toBeCloseTo(1, 9);
    expect(s.slopeRad).toBeCloseTo(0, 9);
  });

  it("UV ↔ world round-trip on corners and center", () => {
    expect(plane.worldToUV(-10, 0, -10)).toEqual([0, 0]);
    expect(plane.worldToUV(10, 0, 10)).toEqual([1, 1]);
    expect(plane.worldToUV(0, 0, 0)).toEqual([0.5, 0.5]);
  });

  it("uvToWorld at center returns (0, 5, 0)", () => {
    const p = plane.uvToWorld(0.5, 0.5);
    expect(p[0]).toBeCloseTo(0, 9);
    expect(p[1]).toBeCloseTo(5, 9);
    expect(p[2]).toBeCloseTo(0, 9);
  });

  it("canAttachAt is false outside [0, 1]², true inside", () => {
    expect(plane.canAttachAt(0.5, 0.5)).toBe(true);
    expect(plane.canAttachAt(-0.1, 0.5)).toBe(false);
    expect(plane.canAttachAt(0.5, 1.1)).toBe(false);
  });

  it("getCurvature is exactly zero for any direction", () => {
    expect(plane.getCurvature(0.3, 0.7, 1, 0)).toBe(0);
    expect(plane.getCurvature(0.3, 0.7, 0, 1)).toBe(0);
    expect(plane.getCurvature(0.3, 0.7, 0.5, 0.5)).toBe(0);
  });
});

describe("PlaneSurfaceProvider — tilted plane", () => {
  // Patch tilted 30° around the X axis: extentU horizontal in +X, extentV rises in +Y, +Z.
  const tilt = 30 * Math.PI / 180;
  const tilted = new PlaneSurfaceProvider({
    id: "ramp",
    origin: [0, 0, 0],
    extentU: [10, 0, 0],
    extentV: [0, 10 * Math.sin(tilt), 10 * Math.cos(tilt)],
  });

  it("slope equals the geometric tilt angle", () => {
    const s = tilted.sampleAtUV(0.5, 0.5);
    expect(s.slopeRad).toBeCloseTo(tilt, 6);
  });

  it("normal points partly into −Z (uphill is +Z)", () => {
    const s = tilted.sampleAtUV(0.5, 0.5);
    expect(s.normal[1]).toBeCloseTo(Math.cos(tilt), 6);
    expect(s.normal[2]).toBeCloseTo(-Math.sin(tilt), 6);
  });
});

// ---------------------------------------------------------------------------
// CylindricalSurfaceProvider
// ---------------------------------------------------------------------------

describe("CylindricalSurfaceProvider — convex (horizontal-axis log)", () => {
  // 20m-radius cylinder, axis along +Z, length 100m. "Top of log" is u=0.
  const cyl = new CylindricalSurfaceProvider({
    id: "log",
    axisOrigin: [0, 0, 0],
    axisDirection: [0, 0, 1],
    radius: 20,
    height: 100,
    concave: false,
  });

  it("u=0 puts you at the top (world +Y)", () => {
    const s = cyl.sampleAtUV(0, 0.5);
    expect(s.position[1]).toBeCloseTo(20, 6);
    // Normal points outward = world +Y at u=0
    expect(s.normal[1]).toBeCloseTo(1, 6);
  });

  it("u=0.25 puts you at the +perpB side", () => {
    // axis +Z, perpA = +Y, perpB = axis × perpA = +Z × +Y = -X
    const s = cyl.sampleAtUV(0.25, 0.5);
    // Position should be axisOrigin + R·perpB = (0 + 20·(-1), 0, 0) = (-20, 0, 0)
    expect(s.position[0]).toBeCloseTo(-20, 6);
    expect(s.position[1]).toBeCloseTo(0, 6);
    expect(s.normal[0]).toBeCloseTo(-1, 6);
  });

  it("tangents are orthonormal and perpendicular to normal", () => {
    const s = cyl.sampleAtUV(0.3, 0.5);
    expect(length(s.normal)).toBeCloseTo(1, 9);
    expect(length(s.tangentU)).toBeCloseTo(1, 9);
    expect(length(s.tangentV)).toBeCloseTo(1, 9);
    expect(dot(s.tangentU, s.tangentV)).toBeCloseTo(0, 9);
    expect(dot(s.tangentU, s.normal)).toBeCloseTo(0, 9);
    expect(dot(s.tangentV, s.normal)).toBeCloseTo(0, 9);
  });

  it("curvature along U is negative (convex, centripetal away from body)", () => {
    // II(dirU=1, dirV=0) = -(2π)²·R for convex
    const k = cyl.getCurvature(0.5, 0.5, 1, 0);
    expect(k).toBeCloseTo(-TWO_PI_SQ * 20, 6);
  });

  it("curvature along V is zero (axis direction is flat)", () => {
    expect(cyl.getCurvature(0.5, 0.5, 0, 1)).toBeCloseTo(0, 9);
  });

  it("curvature is bilinear in direction (scales as dirU²)", () => {
    const base = cyl.getCurvature(0.5, 0.5, 1, 0);
    const doubled = cyl.getCurvature(0.5, 0.5, 2, 0);
    expect(doubled).toBeCloseTo(4 * base, 6);
  });

  it("converted to physical centripetal accel matches v²/R", () => {
    // Character at uDot = vWorld / (2π·R) runs at vWorld around the perimeter.
    // II(uDot, 0) should equal −vWorld²/R for convex.
    const vWorld = 12; // m/s
    const uDot = vWorld / (2 * Math.PI * 20);
    const aCentripetal = cyl.getCurvature(0.5, 0.5, uDot, 0);
    expect(aCentripetal).toBeCloseTo(-vWorld * vWorld / 20, 4);
  });

  it("canAttachAt is false outside [0, 1]²", () => {
    expect(cyl.canAttachAt(0.5, 0.5)).toBe(true);
    expect(cyl.canAttachAt(-0.01, 0.5)).toBe(false);
    expect(cyl.canAttachAt(0.5, 1.5)).toBe(false);
  });
});

describe("CylindricalSurfaceProvider — concave (half-pipe)", () => {
  // 8m-radius cylinder, axis along +Z, concave (inside-facing).
  const pipe = new CylindricalSurfaceProvider({
    id: "halfpipe",
    axisOrigin: [0, 0, 0],
    axisDirection: [0, 0, 1],
    radius: 8,
    height: 40,
    concave: true,
  });

  it("at u=0.5 (bottom of half-pipe) the normal points world +Y", () => {
    // u=0.5 → angle π → radial = -perpA = -Y. Concave flips → normal = +Y.
    const s = pipe.sampleAtUV(0.5, 0.5);
    expect(s.normal[1]).toBeCloseTo(1, 6);
    expect(s.position[1]).toBeCloseTo(-8, 6);
  });

  it("curvature along U is positive (concave, centripetal toward body)", () => {
    const k = pipe.getCurvature(0.5, 0.5, 1, 0);
    expect(k).toBeCloseTo(TWO_PI_SQ * 8, 6);
  });

  it("converted to physical centripetal accel matches +v²/R", () => {
    const vWorld = 12;
    const uDot = vWorld / (2 * Math.PI * 8);
    const aCentripetal = pipe.getCurvature(0.5, 0.5, uDot, 0);
    expect(aCentripetal).toBeCloseTo(+vWorld * vWorld / 8, 4);
  });
});

// ---------------------------------------------------------------------------
// TorusSurfaceProvider
// ---------------------------------------------------------------------------

describe("TorusSurfaceProvider — convex (outside of donut)", () => {
  // Major R = 30, minor r = 8, axis = +Y (donut sitting flat on world XZ plane).
  const torus = new TorusSurfaceProvider({
    id: "donut",
    center: [0, 0, 0],
    axisDirection: [0, 1, 0],
    majorRadius: 30,
    minorRadius: 8,
    concave: false,
  });

  it("on the outer equator (v=0), normal points outward in the XZ plane", () => {
    // u=0 → rmajor = +X (perpA from basisPerpendicular for axis=+Y is +X).
    // v=0 → outward = +rmajor = +X. Position = center + R·rmajor + r·rmajor = (R+r, 0, 0).
    const s = torus.sampleAtUV(0, 0);
    expect(s.position[0]).toBeCloseTo(38, 6);
    expect(s.position[1]).toBeCloseTo(0, 6);
    expect(s.position[2]).toBeCloseTo(0, 6);
    expect(s.normal[0]).toBeCloseTo(1, 6);
    expect(s.normal[1]).toBeCloseTo(0, 6);
  });

  it("on the top of the tube (v=0.25), position is above the spine", () => {
    // v=0.25 → outward = +axisDir = +Y. Position = center + R·rmajor + r·axisDir.
    // u=0 → rmajor = +X. Position = (R, r, 0) = (30, 8, 0).
    const s = torus.sampleAtUV(0, 0.25);
    expect(s.position[0]).toBeCloseTo(30, 6);
    expect(s.position[1]).toBeCloseTo(8, 6);
    expect(s.position[2]).toBeCloseTo(0, 6);
    expect(s.normal[1]).toBeCloseTo(1, 6);
  });

  it("at outer equator, curvature is negative in both U and V directions (convex saddle-free)", () => {
    // II = −(R+r)·dirU² − r·dirV² at v=0, convex
    const kU = torus.getCurvature(0, 0, 1, 0);
    const kV = torus.getCurvature(0, 0, 0, 1);
    expect(kU).toBeCloseTo(-TWO_PI_SQ * (30 + 8), 6);
    expect(kV).toBeCloseTo(-TWO_PI_SQ * 8, 6);
  });

  it("centripetal acc on outer equator running along major direction matches −v²/(R+r)", () => {
    const vWorld = 10;
    // ∂P/∂u norm at v=0 is 2π·(R+r); uDot = vWorld / (2π·(R+r))
    const uDot = vWorld / (2 * Math.PI * (30 + 8));
    const aN = torus.getCurvature(0, 0, uDot, 0);
    expect(aN).toBeCloseTo(-vWorld * vWorld / (30 + 8), 4);
  });
});

describe("TorusSurfaceProvider — concave (inside of tube is a saddle)", () => {
  const tube = new TorusSurfaceProvider({
    id: "tube",
    center: [0, 0, 0],
    axisDirection: [0, 1, 0],
    majorRadius: 30,
    minorRadius: 8,
    concave: true,
  });

  it("at inner-tube point (v=0.5, u=0), normal points outward toward +X", () => {
    // v=0.5 → outward (in our sign) = −rmajor. Concave flips → normal = +rmajor = +X.
    // Position = center + R·rmajor + r·(−rmajor) = ((R−r), 0, 0) = (22, 0, 0).
    const s = tube.sampleAtUV(0, 0.5);
    expect(s.position[0]).toBeCloseTo(22, 6);
    expect(s.position[1]).toBeCloseTo(0, 6);
    expect(s.normal[0]).toBeCloseTo(1, 6);
  });

  it("at v=0.5, curvature along minor (V) is positive (concave around tube)", () => {
    // II_V at v=0.5, ε=−1 (concave): II = −(−1)·(2π)²·r·dirV² = +(2π)²·r·dirV²
    const kV = tube.getCurvature(0, 0.5, 0, 1);
    expect(kV).toBeCloseTo(+TWO_PI_SQ * 8, 6);
  });

  it("at v=0.5, curvature along major (U) is negative (saddle — major direction is convex)", () => {
    // II_U at v=0.5, cos2πv=−1, ε=−1:
    //   II = −(−1)·(2π)²·(R + r·(−1))·(−1)·dirU² = −(2π)²·(R−r)·dirU²
    const kU = tube.getCurvature(0, 0.5, 1, 0);
    expect(kU).toBeCloseTo(-TWO_PI_SQ * (30 - 8), 6);
  });
});
