import { describe, it, expect } from "vitest";
import { resolveDiscContacts } from "../../../src/lib/math/discContact";
import type { ProfileVertex, ProfileIntersection } from "../../../src/lib/math/wheelIntersect";

describe("resolveDiscContacts", () => {
  it("returns null when there are no intersections (body airborne)", () => {
    const profile: ProfileVertex[] = [
      { s: -1, y: 0 },
      { s: 1, y: 0 },
    ];
    expect(resolveDiscContacts([], profile, 0.5)).toBeNull();
  });

  it("single contact on flat ground → disc center directly above at +R", () => {
    const profile: ProfileVertex[] = [
      { s: -1, y: 0 },
      { s: 1, y: 0 },
    ];
    const contact: ProfileIntersection = { s: 0, y: 0, segmentIndex: 0, t: 0.5 };
    const res = resolveDiscContacts([contact], profile, 0.5)!;
    expect(res.kind).toBe("tangent");
    expect(res.centerS).toBeCloseTo(0, 6);
    expect(res.centerY).toBeCloseTo(0.5, 6);
    expect(res.normalS).toBeCloseTo(0, 6);
    expect(res.normalY).toBeCloseTo(1, 6);
  });

  it("single contact on 45° slope → disc center offset along the slope's outward normal", () => {
    // Slope rising +s direction at 45°. Direction (1,1)/√2, outward normal (-1,1)/√2.
    const profile: ProfileVertex[] = [
      { s: -1, y: -1 },
      { s: 1, y: 1 },
    ];
    const contact: ProfileIntersection = { s: 0, y: 0, segmentIndex: 0, t: 0.5 };
    const R = 0.5;
    const res = resolveDiscContacts([contact], profile, R)!;
    expect(res.kind).toBe("tangent");
    // Offset along normalized (-1, 1)/√2 by R.
    expect(res.centerS).toBeCloseTo(-R / Math.SQRT2, 6);
    expect(res.centerY).toBeCloseTo(R / Math.SQRT2, 6);
    expect(res.normalS).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(res.normalY).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("two contacts on a concave L-corner (flat + vertical wall) → disc tucked at (−R, R)", () => {
    // Profile: floor from s=-2 to s=0 (y=0); wall going up at s=0.
    // Approximate the vertical wall as a very steep segment for numerical stability.
    const profile: ProfileVertex[] = [
      { s: -2, y: 0 },     // 0
      { s: 0, y: 0 },      // 1 (corner)
      { s: 0.0001, y: 2 }, // 2 (approximates vertical wall)
    ];
    const R = 0.5;
    // Two contacts: one on floor at (-R, 0); one on the wall at (~0, R).
    const contactFloor: ProfileIntersection = { s: -R, y: 0, segmentIndex: 0, t: (2 - R) / 2 };
    const contactWall: ProfileIntersection = { s: 0.000025, y: R, segmentIndex: 1, t: R / 2 };
    const res = resolveDiscContacts([contactFloor, contactWall], profile, R)!;
    expect(res.kind).toBe("corner");
    // Disc center for a 90° concave corner should be at (−R, R).
    expect(res.centerS).toBeCloseTo(-R, 2);
    expect(res.centerY).toBeCloseTo(R, 2);
    // Contact normal points away from the corner = up-right bisector.
    expect(res.normalS).toBeLessThan(0); // away from wall (which is on +s side)
    expect(res.normalY).toBeGreaterThan(0); // up
  });

  it("two contacts on the SAME segment (embedded chord) → pop disc out perpendicular to tangent", () => {
    const profile: ProfileVertex[] = [
      { s: -2, y: 0 },
      { s: 2, y: 0 },
    ];
    // Disc center at (0, 0.3) has chord intersections with y=0 at s = ±0.4.
    const R = 0.5;
    const a: ProfileIntersection = { s: -0.4, y: 0, segmentIndex: 0, t: 0.4 };
    const b: ProfileIntersection = { s: 0.4, y: 0, segmentIndex: 0, t: 0.6 };
    const res = resolveDiscContacts([a, b], profile, R)!;
    expect(res.kind).toBe("pop-out");
    // Pop-out semantics: move the disc so it's TANGENT to the segment (no
    // longer crosses through it). For a flat segment with chord midpoint at
    // (0, 0), the tangent disc-center is at (0, R) = (0, 0.5). Earlier
    // version of this test expected perpDist = √(R²-half²) = 0.3, which
    // would leave the disc embedded; that was the buggy math (see
    // resolvePopOut in discContact.ts).
    expect(res.centerS).toBeCloseTo(0, 6);
    expect(res.centerY).toBeCloseTo(0.5, 6);
    expect(res.normalS).toBeCloseTo(0, 6);
    expect(res.normalY).toBeCloseTo(1, 6);
  });

  it("two contacts on different but parallel segments → fallback to single tangent", () => {
    // Two collinear flat segments. No real corner.
    const profile: ProfileVertex[] = [
      { s: -2, y: 0 },
      { s: 0, y: 0 },
      { s: 2, y: 0 },
    ];
    const a: ProfileIntersection = { s: -0.4, y: 0, segmentIndex: 0, t: 0.8 };
    const b: ProfileIntersection = { s: 0.4, y: 0, segmentIndex: 1, t: 0.2 };
    const res = resolveDiscContacts([a, b], profile, 0.5)!;
    expect(res.kind).toBe("fallback-parallel");
    // Forward contact (b) is at s=+0.4. Disc center for single tangent is contact + R·normal.
    expect(res.centerS).toBeCloseTo(0.4, 6);
    expect(res.centerY).toBeCloseTo(0.5, 6);
  });

  it("3+ distinct contacts → reduces to the two extremes (smallest + largest s)", () => {
    const profile: ProfileVertex[] = [
      { s: -2, y: 0 },
      { s: 0, y: 0 },
      { s: 0.0001, y: 2 },
    ];
    const R = 0.5;
    const c1: ProfileIntersection = { s: -R, y: 0, segmentIndex: 0, t: (2 - R) / 2 };
    const c2: ProfileIntersection = { s: -0.1, y: 0, segmentIndex: 0, t: 0.95 };
    const c3: ProfileIntersection = { s: 0.000025, y: R, segmentIndex: 1, t: R / 2 };
    const res = resolveDiscContacts([c1, c2, c3], profile, R)!;
    // Should pick extremes c1 (smallest s) and c3 (largest s); resolve as corner.
    expect(res.kind).toBe("corner");
    expect(res.centerS).toBeCloseTo(-R, 1);
    expect(res.centerY).toBeCloseTo(R, 1);
  });

  it("duplicate intersections (same s, y) are deduplicated", () => {
    const profile: ProfileVertex[] = [
      { s: -1, y: 0 },
      { s: 0, y: 0 },
      { s: 1, y: 0 },
    ];
    // The wheel intersection solver can emit the same physical point twice
    // (segment i's t=1 = segment i+1's t=0). Dedup should treat as a single contact.
    const a: ProfileIntersection = { s: 0, y: 0, segmentIndex: 0, t: 1 };
    const aDup: ProfileIntersection = { s: 0, y: 0, segmentIndex: 1, t: 0 };
    const res = resolveDiscContacts([a, aDup], profile, 0.5)!;
    expect(res.kind).toBe("tangent");
    // Single contact at (0, 0) → disc center directly above.
    expect(res.centerS).toBeCloseTo(0, 6);
    expect(res.centerY).toBeCloseTo(0.5, 6);
  });
});
