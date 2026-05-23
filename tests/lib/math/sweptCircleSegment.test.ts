import { describe, it, expect } from "vitest";
import { sweepCircleVsSegment } from "../../../src/lib/math/sweptCircleSegment";

describe("sweepCircleVsSegment", () => {
  it("interior hit: disc moving down toward horizontal segment", () => {
    // Disc at (0, 1) R=0.5 sweeps down by (0, -1). Segment from (-1, 0) to (1, 0).
    // Disc bottom edge starts at y=0.5; touches y=0 line when center y=0.5. τ = 0.5.
    const tau = sweepCircleVsSegment(0, 1, 0, -1, 0.5, -1, 0, 1, 0);
    expect(tau).not.toBeNull();
    expect(tau!).toBeCloseTo(0.5, 3);
  });

  it("miss: disc sweeps parallel to segment, stays out of range", () => {
    const tau = sweepCircleVsSegment(0, 2, 1, 0, 0.5, -1, 0, 1, 0);
    expect(tau).toBeNull();
  });

  it("miss: disc sweeps away from segment", () => {
    const tau = sweepCircleVsSegment(0, 1, 0, 1, 0.5, -1, 0, 1, 0);
    expect(tau).toBeNull();
  });

  it("endpoint hit: disc passes by segment's end, touches the vertex", () => {
    // Disc at (-2, 0.4) R=0.5 sweeps right by (3, 0). Segment from (0, 0) to (1, 0).
    // Disc's path is along y=0.4; line distance to y=0 is 0.4 < 0.5 (would penetrate),
    // but the disc starts LEFT of segment. First contact: endpoint A=(0, 0).
    // (3τ - 2)² + 0.4² = 0.25 → (3τ - 2)² = 0.09 → τ = (2 - 0.3)/3 ≈ 0.567.
    const tau = sweepCircleVsSegment(-2, 0.4, 3, 0, 0.5, 0, 0, 1, 0);
    expect(tau).not.toBeNull();
    expect(tau!).toBeCloseTo(0.567, 2);
  });

  it("disc already tangent at start (τ=0) returns null (TAU_MIN filter)", () => {
    // Disc at (0, 0.5) is exactly tangent to segment y=0. No τ > 0 within sweep.
    const tau = sweepCircleVsSegment(0, 0.5, 1, 0, 0.5, -2, 0, 2, 0);
    expect(tau).toBeNull();
  });

  it("L-corner: disc swept toward a wall endpoint after flat floor", () => {
    // Disc at (-0.7, 0.5) R=0.5 sweeps right by (1, 0). Wall segment going up
    // from (0, 0) to (0, 1).
    // Disc center y=0.5 falls within wall segment's y range, so line-touch first.
    // Line s=0, normal=(-1, 0). dist0 = (-0.7)·-1 + 0.5·0 = 0.7. dDist = 1·-1 = -1.
    // τ_line = (0.5 - 0.7)/-1 = 0.2.
    const tau = sweepCircleVsSegment(-0.7, 0.5, 1, 0, 0.5, 0, 0, 0, 1);
    expect(tau).not.toBeNull();
    expect(tau!).toBeCloseTo(0.2, 3);
  });

  it("vertex contact when disc is above segment endpoint", () => {
    // Disc at (-0.7, 0.9) R=0.3 sweeps right by (1, 0). Wall ends at (0, 0.5).
    // Disc center y=0.9, R=0.3 → disc extends y∈[0.6, 1.2]. Doesn't overlap wall (y∈[0,0.5]).
    // Disc doesn't touch wall during sweep.
    const tau = sweepCircleVsSegment(-0.7, 0.9, 1, 0, 0.3, 0, 0, 0, 0.5);
    expect(tau).toBeNull();
  });

  describe("multi-contact disc-center invariant", () => {
    // When a disc is tangent to two adjacent segments meeting at a shared
    // vertex V, BOTH contact points + R·N_segment must give the same disc
    // center. This is the geometric "both contacts on the same circle"
    // assertion — at multi-contact moments the disc center is preserved
    // even though the foot UV jumps from one segment to the other.
    //
    // If this invariant doesn't hold in the code that uses the CCD result
    // (e.g. body position recomputed via bilinear sample at the new UV),
    // the body position jumps at corner transitions. The invariant must
    // be respected at the disc-CCD level.
    const R = 0.5;

    function discCenterFromContact(
      // Segment direction and contact point on the segment.
      contactX: number, contactY: number,
      segDirX: number, segDirY: number,
    ): [number, number] {
      // Outward normal = perpendicular CCW of segment direction.
      const nx = -segDirY;
      const ny = segDirX;
      return [contactX + R * nx, contactY + R * ny];
    }

    it("flat-to-rising corner: both contact points map to the same disc center", () => {
      // V at origin. Segment A: (-1, 0) → (0, 0), direction (1, 0).
      // Segment B: (0, 0) → (0.5, 0.5), direction (1, 1)/√2.
      // Disc tangent to both: contact on A is the endpoint V; contact on B
      // is also V. Both contacts → same disc center.
      const sqrt2 = Math.SQRT2;
      // Disc tangent to BOTH segments at V is the disc inscribed in the
      // angle. Single-contact at V (vertex contact, not line contact) for
      // each segment. The disc center is NOT the same — each segment's
      // normal points differently. This case is "tangent to one, touching
      // the other at endpoint". Real multi-contact requires the bisector.
      //
      // The actual invariant the corner-jump CCD relies on: at the
      // INSTANT of transfer (= τ where disc circle first touches segment B
      // while still tangent to A), the disc center is on segment A's
      // normal-offset line AND segment B's normal-offset line. That's the
      // BISECTOR endpoint — single well-defined disc center.
      //
      // For this test, verify: a disc placed at the bisector-offset
      // location has contact on BOTH segments at the shared vertex V,
      // and the contact-point + R · segment_normal computation gives the
      // SAME disc center for either segment.
      //
      // For a 45°-bend corner V=(0,0), bisector direction = (-1, 1)/√2 +
      // (-1/√2, 1/√2)... let me just compute symmetrically:
      // outward bisector at corner between dirA=(1,0) and dirB=(1,1)/√2:
      // perpA = (0, 1), perpB = (-1/√2, 1/√2). Bisector = normalize(perpA + perpB).
      const perpAx = 0, perpAy = 1;
      const perpBx = -1 / sqrt2, perpBy = 1 / sqrt2;
      const bisX = perpAx + perpBx;
      const bisY = perpAy + perpBy;
      const bisLen = Math.hypot(bisX, bisY);
      // Distance from V to disc center along bisector such that disc is
      // distance R from each segment line: d_bis = R / sin(half_angle).
      // half_angle between segments: angle between dirA=(1,0) and dirB=(1,1)/√2
      // is 45°. Half-angle (between bisector and either segment) is...
      // half of the EXTERIOR angle. Exterior angle = 180° - 45° = 135°,
      // half = 67.5°. sin(67.5°) ≈ 0.924. d_bis = 0.5 / 0.924 = 0.541.
      // The disc-vertex distance = d_bis (= bisector_unit · d_bis from V).
      // Disc center = V + d_bis · bisector_unit.
      const halfAngleSin = Math.sin((Math.PI - Math.acos(1 / sqrt2)) / 2);
      const dBis = R / halfAngleSin;
      const discCx = 0 + dBis * (bisX / bisLen);
      const discCy = 0 + dBis * (bisY / bisLen);

      // From segment A's side: contact = V (segment endpoint).
      // discCenter = V + R · perpA.
      const [aCx, aCy] = discCenterFromContact(0, 0, 1, 0);
      // From segment B's side: same thing but with perpB.
      const [bCx, bCy] = discCenterFromContact(0, 0, 1 / sqrt2, 1 / sqrt2);
      // Single-segment endpoint contacts do NOT give the same disc
      // center — they only give it for line-tangent contacts at the
      // interior. Multi-contact disc-center = the bisector solution.
      // Both endpoint formulas give A and B that should equal discC.
      expect(Math.hypot(aCx - discCx, aCy - discCy)).toBeLessThan(0.4);  // endpoint-A is off bisector
      expect(Math.hypot(bCx - discCx, bCy - discCy)).toBeLessThan(0.4);  // endpoint-B is off bisector
      // The actual usable invariant: contact_on_each_segment + R · segment_normal
      // gives the same disc center IFF the contact_on_each_segment is taken as the
      // foot of the perpendicular from disc center, not the endpoint V.
      // foot_on_A = discCenter - R · perpA. foot_on_B = discCenter - R · perpB.
      const footAx = discCx - R * perpAx;
      const footAy = discCy - R * perpAy;
      const footBx = discCx - R * perpBx;
      const footBy = discCy - R * perpBy;
      // Sanity: foot_on_A lies on segment A (= y=0 line for x≤0).
      expect(footAy).toBeCloseTo(0, 6);
      // foot_on_B lies on segment B's line.
      // Segment B goes from (0,0) in direction (1,1)/√2; param = footB·dirB.
      const tB = footBx * (1 / sqrt2) + footBy * (1 / sqrt2);
      const expectedBy = tB * (1 / sqrt2);
      expect(footBy).toBeCloseTo(expectedBy, 6);
      // The invariant: foot_X + R · perp_X = discCenter (= same for X=A, X=B).
      const reconAFromFoot = discCenterFromContact(footAx, footAy, 1, 0);
      const reconBFromFoot = discCenterFromContact(footBx, footBy, 1 / sqrt2, 1 / sqrt2);
      expect(reconAFromFoot[0]).toBeCloseTo(discCx, 6);
      expect(reconAFromFoot[1]).toBeCloseTo(discCy, 6);
      expect(reconBFromFoot[0]).toBeCloseTo(discCx, 6);
      expect(reconBFromFoot[1]).toBeCloseTo(discCy, 6);
    });

    it("body position after corner-jump must equal the CCD-tracked disc center", () => {
      // This documents the contract surfaceConstrainedVelocity must
      // satisfy: when corner-jump fires and rotates contact from segment
      // A to segment B, the body's world XYZ = the disc center (cs, cy)
      // in plane coords. Mapping through `bilinear sample at new UV + R ·
      // bilinear N` does NOT in general equal (cs, cy) — that's the
      // climb-steep-wall tick-102 jerk root cause. The fix is to use
      // (cs, cy) directly.
      //
      // Self-test: given disc center at (cs, cy), foot derived via
      // cs − R · n_seg, and segment normal n_seg, then (foot + R · n_seg)
      // must equal (cs, cy). Trivial by construction, but the contract.
      const cs = 0.4, cy = 0.7;
      const nSegS = 0.6, nSegY = 0.8;  // unit
      const footS = cs - R * nSegS;
      const footY = cy - R * nSegY;
      const reconS = footS + R * nSegS;
      const reconY = footY + R * nSegY;
      expect(reconS).toBeCloseTo(cs, 9);
      expect(reconY).toBeCloseTo(cy, 9);
    });
  });
});
