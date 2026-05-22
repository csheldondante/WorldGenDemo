import { describe, it, expect } from "vitest";
import {
  sweepCircleVsSegment,
  sweepDiscAgainstProfile,
  iterateDiscSweep,
  sliceProfileAlongVelocity,
  type ProfileVertex,
} from "../../src/world/discSweepCCD";

describe("sweepCircleVsSegment", () => {
  it("disc moving toward a horizontal segment hits it at the predicted τ", () => {
    // Disc at (0, 1), R=0.5. Segment from (-1, 0) to (1, 0). Disc moves down by (0, -1) over τ ∈ [0,1].
    // Disc bottom edge starts at y=0.5; segment is at y=0; touches when disc center y = 0.5 → τ=0.5.
    const tau = sweepCircleVsSegment(0, 1, 0, -1, 0.5, -1, 0, 1, 0);
    expect(tau).not.toBeNull();
    expect(tau).toBeCloseTo(0.5, 3);
  });

  it("disc moving parallel to a far segment never hits", () => {
    // Disc at (0, 2), moving right by (1, 0). Segment from (-1, 0) to (1, 0). Distance 2 > R=0.5 always.
    const tau = sweepCircleVsSegment(0, 2, 1, 0, 0.5, -1, 0, 1, 0);
    expect(tau).toBeNull();
  });

  it("disc moving away from a segment never hits", () => {
    // Disc at (0, 1), moving up by (0, 1). Segment below at y=0. Distance increasing.
    const tau = sweepCircleVsSegment(0, 1, 0, 1, 0.5, -1, 0, 1, 0);
    expect(tau).toBeNull();
  });

  it("disc hits an endpoint vertex when sweep passes the segment's end", () => {
    // Disc at (-2, 0.4) moving right by (3, 0), R=0.5. Segment from (0, 0) to (1, 0).
    // The disc's path is along y=0.4. Distance from path to segment-line (y=0) is 0.4 < R=0.5,
    // so disc penetrates the line. But it starts to the LEFT of the segment.
    // First contact: endpoint A=(0, 0). |C(τ) - A|² = R² → (-2 + 3τ)² + 0.4² = 0.25
    // → (3τ - 2)² = 0.25 - 0.16 = 0.09 → 3τ - 2 = ±0.3 → τ = (2 - 0.3)/3 = 0.567 (smaller root).
    const tau = sweepCircleVsSegment(-2, 0.4, 3, 0, 0.5, 0, 0, 1, 0);
    expect(tau).not.toBeNull();
    expect(tau).toBeCloseTo(0.567, 2);
  });
});

describe("sweepDiscAgainstProfile", () => {
  it("returns null when only segment in profile is the skip segment", () => {
    // Flat profile y=0; disc tangent at s=0; sweep forward by (0.5, 0).
    // Skip the single flat segment under the disc — nothing else to hit.
    const profile: ProfileVertex[] = [
      { s: -1, y: 0 }, { s: 1, y: 0 },
    ];
    const hit = sweepDiscAgainstProfile(0, 0.5, 0.5, 0, 0.5, profile, 0);
    expect(hit).toBeNull();
  });

  it("finds the wall contact on a flat→wall step", () => {
    // Profile: flat (-1, 0)→(0, 0) then wall (0, 0)→(0, 1).
    // Disc at (-0.7, 0.5) tangent to flat (skip segment 0). Sweep right by (1, 0).
    // Wall segment is segment 1: (0, 0)→(0, 1). Disc center y=0.5, R=0.5.
    // Disc center reaches s=-R=-0.5 → contact at τ where -0.7 + τ·1 = -0.5 → τ=0.2.
    // Contact point on wall = (0, 0.5) (interior of wall segment).
    const profile: ProfileVertex[] = [
      { s: -1, y: 0 }, { s: 0, y: 0 }, { s: 0, y: 1 },
    ];
    const hit = sweepDiscAgainstProfile(-0.7, 0.5, 1, 0, 0.5, profile, 0);
    expect(hit).not.toBeNull();
    if (!hit) return;
    expect(hit.tau).toBeCloseTo(0.2, 3);
    expect(hit.segmentIndex).toBe(1);
    expect(hit.tangentS).toBeCloseTo(0, 5);
    expect(Math.abs(hit.tangentY)).toBeCloseTo(1, 5);
  });
});

describe("iterateDiscSweep", () => {
  it("smooth roll across a flat profile completes in 0 transitions", () => {
    // Merged: one flat segment (-2, 0)→(2, 0).
    const profile: ProfileVertex[] = [
      { s: -2, y: 0 }, { s: 2, y: 0 },
    ];
    const result = iterateDiscSweep(0, 0.5, 1, 0, 0.5, profile, 0, 1.0, 1.0, 4);
    expect(result.transitions).toBe(0);
    expect(result.hitIterationCap).toBe(false);
    expect(result.centerS).toBeCloseTo(1, 5);
    expect(result.centerY).toBeCloseTo(0.5, 5);
  });

  it("L-corner: forward velocity converts to up velocity at the wall corner", () => {
    // Profile: flat (-1, 0)→(0, 0) then wall (0, 0)→(0, 1)→(0, 2).
    // Disc at (-0.7, 0.5) tangent to flat (segment 0). Velocity (3, 0), dt=0.5.
    // Sweep = (1.5, 0). At τ=0.2/1.5 = 0.133 (disc center reaches s=-0.5), hits wall segment.
    // Velocity rotates to (0, 3) — UP along the wall. Remaining time = (1 - 0.133)·0.5 = 0.433s.
    // Body climbs wall, ending at (0, 0.5 + 3·0.433) = (0, 1.8). Slight numerical
    // tolerance because the parallelism-to-flat check returns null but the new-tangent
    // direction (0,1) is correct.
    // Merged profile: flat (-1,0)→(0,0), then wall (0,0)→(0,2). No collinear joints.
    const profile: ProfileVertex[] = [
      { s: -1, y: 0 }, { s: 0, y: 0 }, { s: 0, y: 2 },
    ];
    const result = iterateDiscSweep(-0.7, 0.5, 3, 0, 0.5, profile, 0, 0.5, 1.0, 4);
    expect(result.hitIterationCap).toBe(false);
    expect(result.transitions).toBeGreaterThanOrEqual(1);
    // Velocity should rotate to mostly along (0, ±1).
    expect(Math.abs(result.velS)).toBeLessThan(0.5);
    expect(Math.abs(result.velY)).toBeGreaterThan(2.5);
    // Speed preserved with efficiency=1.
    const finalSpeed = Math.hypot(result.velS, result.velY);
    expect(finalSpeed).toBeCloseTo(3, 1);
  });

  it("efficiency = 0.5 halves the speed at corner transition", () => {
    // Merged profile: flat (-1,0)→(0,0), then wall (0,0)→(0,2). No collinear joints.
    const profile: ProfileVertex[] = [
      { s: -1, y: 0 }, { s: 0, y: 0 }, { s: 0, y: 2 },
    ];
    const result = iterateDiscSweep(-0.7, 0.5, 3, 0, 0.5, profile, 0, 0.5, 0.5, 4);
    expect(result.hitIterationCap).toBe(false);
    const finalSpeed = Math.hypot(result.velS, result.velY);
    expect(finalSpeed).toBeCloseTo(1.5, 1);
  });

  it("smooth velocity advances by velocity·dt with no transitions", () => {
    const profile: ProfileVertex[] = [
      { s: -2, y: 0 }, { s: 2, y: 0 },
    ];
    const result = iterateDiscSweep(0, 0.5, 5, 0, 0.5, profile, 0, 0.1, 1.0, 4);
    expect(result.transitions).toBe(0);
    expect(result.centerS).toBeCloseTo(0.5, 3);
  });
});

describe("sliceProfileAlongVelocity", () => {
  it("samples a flat heightmap, merges collinear runs into a single segment", () => {
    const sampleHeight = () => 0;
    const profile = sliceProfileAlongVelocity(sampleHeight, 0, 0, 1, 0, 1, 1, 0.5);
    // Flat surface: all samples on y=0; merge collapses to the two endpoints.
    expect(profile.length).toBe(2);
    for (const p of profile) expect(p.y).toBe(0);
  });

  it("samples a ramp heightmap with linearly varying y", () => {
    // Height = x · tan(30°). Profile along +x direction.
    const sampleHeight = (wx: number) => wx * Math.tan(Math.PI / 6);
    const profile = sliceProfileAlongVelocity(sampleHeight, 0, 0, 1, 0, 1, 1, 0.5);
    for (const p of profile) {
      expect(p.y).toBeCloseTo(p.s * Math.tan(Math.PI / 6), 5);
    }
  });
});
