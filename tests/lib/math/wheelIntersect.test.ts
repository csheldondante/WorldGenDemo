import { describe, it, expect } from "vitest";
import {
  findCircleProfileIntersections,
  type ProfileVertex,
} from "../../../src/lib/math/wheelIntersect";

describe("findCircleProfileIntersections", () => {
  it("flat ground at y=0, wheel just touching from above: 1 tangent contact", () => {
    // Circle radius 0.5 centered at (0, 0.5). Surface is the line y = 0.
    const curve: ProfileVertex[] = [
      { s: -2, y: 0 },
      { s: 2, y: 0 },
    ];
    const out = findCircleProfileIntersections(0, 0.5, 0.5, curve);
    expect(out.length).toBe(1);
    expect(out[0].s).toBeCloseTo(0, 6);
    expect(out[0].y).toBeCloseTo(0, 6);
  });

  it("flat ground, wheel hovering above: 0 intersections", () => {
    const curve: ProfileVertex[] = [
      { s: -2, y: 0 },
      { s: 2, y: 0 },
    ];
    // center y = 1, radius 0.5 → bottom at 0.5, surface at 0 → no contact.
    const out = findCircleProfileIntersections(0, 1, 0.5, curve);
    expect(out.length).toBe(0);
  });

  it("flat ground, wheel sunk: 2 intersections (chord)", () => {
    const curve: ProfileVertex[] = [
      { s: -2, y: 0 },
      { s: 2, y: 0 },
    ];
    // center (0, 0.3), radius 0.5 → circle's top at 0.8, bottom at -0.2.
    // Surface y=0 cuts the circle at s = ±√(0.5² − 0.3²) = ±0.4.
    const out = findCircleProfileIntersections(0, 0.3, 0.5, curve);
    expect(out.length).toBe(2);
    expect(out[0].s).toBeCloseTo(-0.4, 6);
    expect(out[1].s).toBeCloseTo(0.4, 6);
    expect(out[0].y).toBeCloseTo(0, 6);
    expect(out[1].y).toBeCloseTo(0, 6);
  });

  it("concave L-corner (flat → vertical wall): wheel tucked into corner finds 2 contacts", () => {
    // Floor on the LEFT at y=0 (s < 0), wall going up at s=0.
    //   (-2, 0) → (0, 0) → (0, 1) → (2, 1)
    // Wheel center at (−R, R) = (−0.5, 0.5): touches floor at (−0.5, 0) and
    // touches wall at (0, 0.5). Both contacts at distance R from center.
    const curve: ProfileVertex[] = [
      { s: -2, y: 0 },
      { s: 0, y: 0 },
      { s: 0, y: 1 },
      { s: 2, y: 1 },
    ];
    const out = findCircleProfileIntersections(-0.5, 0.5, 0.5, curve);
    // Expect 2 tangent contacts (one per perpendicular segment).
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Floor contact ≈ (−0.5, 0)
    const floorHit = out.find(
      (h) => Math.abs(h.s + 0.5) < 1e-6 && Math.abs(h.y) < 1e-6,
    );
    expect(floorHit).toBeDefined();
    // Wall contact ≈ (0, 0.5)
    const wallHit = out.find(
      (h) => Math.abs(h.s) < 1e-6 && Math.abs(h.y - 0.5) < 1e-6,
    );
    expect(wallHit).toBeDefined();
  });

  it("smooth slope (single linear segment), wheel just touching: 1 tangent contact", () => {
    // 45° slope: y = s for s in [-2, 2]. Wheel radius 0.5 tangent to it.
    const curve: ProfileVertex[] = [
      { s: -2, y: -2 },
      { s: 2, y: 2 },
    ];
    const out = findCircleProfileIntersections(0, 0.5 * Math.SQRT2, 0.5, curve);
    expect(out.length).toBe(1);
    expect(out[0].s).toBeCloseTo(0.5 / Math.SQRT2, 5);
    expect(out[0].y).toBeCloseTo(0.5 / Math.SQRT2, 5);
  });

  it("wheel far from surface: 0 intersections", () => {
    const curve: ProfileVertex[] = [
      { s: -2, y: 0 },
      { s: 2, y: 0 },
    ];
    const out = findCircleProfileIntersections(0, 100, 0.5, curve);
    expect(out.length).toBe(0);
  });

  it("degenerate zero-length segment is skipped, doesn't crash", () => {
    const curve: ProfileVertex[] = [
      { s: 0, y: 0 },
      { s: 0, y: 0 }, // duplicate vertex
      { s: 1, y: 0 },
    ];
    const out = findCircleProfileIntersections(0.5, 0.5, 0.5, curve);
    // Wheel at (0.5, 0.5), radius 0.5, tangent to y=0 at (0.5, 0). One contact.
    expect(out.length).toBe(1);
  });

  it("intersections are returned in segment order", () => {
    const curve: ProfileVertex[] = [
      { s: -5, y: 0 },
      { s: -1, y: 0 },
      { s: 1, y: 0 },
      { s: 5, y: 0 },
    ];
    // Big wheel at (0, 0.3), R = 0.5 → cuts y=0 at s=±0.4. Both fall in segment 1.
    const out = findCircleProfileIntersections(0, 0.3, 0.5, curve);
    expect(out.length).toBe(2);
    expect(out[0].segmentIndex).toBe(1);
    expect(out[1].segmentIndex).toBe(1);
    expect(out[0].s).toBeLessThan(out[1].s);
  });
});
