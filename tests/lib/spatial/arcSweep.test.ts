import { describe, it, expect } from "vitest";
import { sweepSphereVsHeightSurface, type HeightSurfaceQuery } from "../../../src/lib/spatial/arcSweep";

/** Flat ground at y=0 covering all x,z. */
const flatGround: HeightSurfaceQuery = () => ({ height: 0, normal: [0, 1, 0] });

/** A vertical wall at x=5: terrain is at y=0 for x<5, y=10 for x>=5. Wall normal points -X. */
const wallAt5: HeightSurfaceQuery = (x: number, _z: number) => {
  if (x < 5) return { height: 0, normal: [0, 1, 0] };
  return { height: 10, normal: [-1, 0, 0] };
};

describe("sweepSphereVsHeightSurface", () => {
  it("no contact when body stays above flat ground", () => {
    // Sphere at (0, 5, 0), velocity (0, 0, 0), gravity 0. Stays put.
    const hit = sweepSphereVsHeightSurface(
      [0, 5, 0], [0, 0, 0], [0, 0, 0], 1.0, 0.5, flatGround,
    );
    expect(hit).toBeNull();
  });

  it("contact when sphere falls onto flat ground under gravity", () => {
    // Sphere at (0, 2, 0), falling under -9.81. Bottom (y - r) starts at 1.5,
    // touches 0 when p.y = 0.5 → y(t) = 2 - 0.5*9.81*t² = 0.5 → t² = 3/9.81
    // → t ≈ 0.553s. Within a 1s frame, should detect.
    const hit = sweepSphereVsHeightSurface(
      [0, 2, 0], [0, 0, 0], [0, -9.81, 0], 1.0, 0.5, flatGround,
    );
    expect(hit).not.toBeNull();
    expect(hit!.t).toBeCloseTo(0.553, 1);
    expect(hit!.point[1]).toBeCloseTo(0.5, 1);
    expect(hit!.normal).toEqual([0, 1, 0]);
  });

  it("no contact in a sub-frame interval that's too short to reach the ground", () => {
    // Same falling sphere but dt=0.1s — only 4.9 cm drop, body still above ground.
    const hit = sweepSphereVsHeightSurface(
      [0, 2, 0], [0, 0, 0], [0, -9.81, 0], 0.1, 0.5, flatGround,
    );
    expect(hit).toBeNull();
  });

  it("high-velocity horizontal motion into a wall detects clipping (the user's steep-wall case)", () => {
    // Sphere starts at (4, 5, 0), velocity (+20, 0, 0). At t=0 it's 1 unit away from
    // the wall at x=5; wall height 10 means body is BELOW the top. Without CCD,
    // single-tick integration (16ms) at 20 m/s = 0.32m would put the body at x=4.32,
    // still outside in a normal naive test. But for a 0.1s frame, body would be at
    // x=6 — well inside the wall. Test the latter: dt=0.1s.
    const hit = sweepSphereVsHeightSurface(
      [4, 5, 0], [20, 0, 0], [0, 0, 0], 0.1, 0.5, wallAt5,
    );
    expect(hit).not.toBeNull();
    // Body bottom (y=4.5) is below wall top (y=10) for all t > 0. Hit when body
    // first crosses x=5 (where terrain jumps from 0 to 10). Body x = 4 + 20t = 5
    // → t = 0.05s. With radius 0.5 the body sphere touches the wall earlier when
    // the closest body point (centre + radius along +X) crosses x=5: 4 + 20t + 0.5
    // = 5 → t = 0.025. But our sweep tracks body CENTRE against terrain height —
    // signed distance becomes negative when body.y - radius <= h, which on the
    // wall side means body.y - 0.5 <= 10 → always (body.y is 5). So the first
    // sample inside (i/N) is the first substep that crosses x=5. At N=8 over
    // dt=0.1s, t-step = 0.0125s, body advances 0.25m per step. Substep 1: x=4.25.
    // Substep 2: x=4.5. Substep 3: x=4.75. Substep 4: x=5.0 (first inside). So
    // bisection refines around t=0.05s.
    expect(hit!.t).toBeGreaterThan(0.04);
    expect(hit!.t).toBeLessThan(0.06);
  });

  it("returns t=0 if body starts embedded", () => {
    const hit = sweepSphereVsHeightSurface(
      [0, -0.5, 0], [0, 0, 0], [0, 0, 0], 1.0, 0.5, flatGround,
    );
    expect(hit).not.toBeNull();
    expect(hit!.t).toBe(0);
  });

  it("returns null when arc stays entirely above terrain", () => {
    // Ballistic arc launched upward: y(t) = 5 + 10t - 4.905t². Peaks at t=10/9.81 ≈ 1.02s,
    // y_peak ≈ 5 + 10.2 = 15.2. Falls back to y=5 at t ≈ 2.04s. We sample over dt=1s —
    // body stays above 5.
    const hit = sweepSphereVsHeightSurface(
      [0, 5, 0], [0, 10, 0], [0, -9.81, 0], 1.0, 0.5, flatGround,
    );
    expect(hit).toBeNull();
  });

  it("null heightQuery (outside surface region) skips that substep", () => {
    // Heightmap only defined for |x| < 10; body flies outside that region but back.
    const partialGround: HeightSurfaceQuery = (x: number, _z: number) => {
      if (Math.abs(x) > 10) return null;
      return { height: 0, normal: [0, 1, 0] };
    };
    // Body at (5, 2, 0) moving in +X at 50 m/s under gravity. Body crosses x=10 at
    // t=0.1s — out-of-bounds samples skipped — and reaches x=15 at t=0.2s.
    // Within dt=0.1s body has not hit ground.
    const hit = sweepSphereVsHeightSurface(
      [5, 2, 0], [50, 0, 0], [0, -9.81, 0], 0.1, 0.5, partialGround,
    );
    expect(hit).toBeNull();
  });

  it("custom substep count: more substeps → more accurate t", () => {
    // Same falling sphere, but compare N=4 vs N=32 substep accuracy.
    const hitCoarse = sweepSphereVsHeightSurface(
      [0, 2, 0], [0, 0, 0], [0, -9.81, 0], 1.0, 0.5, flatGround, 4, 4,
    );
    const hitFine = sweepSphereVsHeightSurface(
      [0, 2, 0], [0, 0, 0], [0, -9.81, 0], 1.0, 0.5, flatGround, 32, 8,
    );
    expect(hitCoarse).not.toBeNull();
    expect(hitFine).not.toBeNull();
    // Both should be near 0.553, but fine should be closer.
    expect(Math.abs(hitFine!.t - 0.553)).toBeLessThan(Math.abs(hitCoarse!.t - 0.553) + 0.01);
  });
});
