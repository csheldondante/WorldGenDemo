/**
 * Analytical circle-vs-piecewise-linear-curve intersection.
 *
 * Used by `surfaceConstrainedVelocitySystem` to detect concave-corner
 * crossings: the body is modeled as a wheel (circle of radius R) in its
 * velocity plane, and the surface profile in that plane is a piecewise
 * linear curve (a heightmap restricted to a vertical plane sampled at
 * cell boundaries). If the wheel intersects the profile at more than one
 * point, the body is straddling a concave corner — the second intersection
 * (in momentum direction) is the new contact, and the body's UV jumps to it.
 *
 * Pure 2D — no heightmap-specific logic. The caller is responsible for
 * building the (s, y) profile vertices and locating the wheel center in
 * the same 2D coordinate system (s = horizontal arc-length along the
 * velocity plane; y = vertical, gravity-up).
 */

/** A point on the piecewise-linear surface profile, in the velocity plane. */
export interface ProfileVertex {
  /** Horizontal arc-length along the velocity plane's horizontal direction. */
  s: number;
  /** Height at this arc-length (world-up direction). */
  y: number;
}

/** A single circle-profile intersection. */
export interface ProfileIntersection {
  s: number;
  y: number;
  /** Index of the profile segment (between curve[i] and curve[i+1]). */
  segmentIndex: number;
  /** t in [0, 1] along that segment where the intersection sits. */
  t: number;
}

/**
 * Find all intersections of a 2D circle with a piecewise-linear curve.
 *
 *   circle: center = (centerS, centerY), radius = R.
 *   curve:  ordered array of (s_i, y_i) vertices.
 *           Segments = consecutive pairs.
 *
 * For each segment between `curve[i]` and `curve[i+1]`, parameterise as
 *   P(t) = curve[i] + t · (curve[i+1] − curve[i]),  t ∈ [0, 1]
 * and solve |P(t) − center|² = R². This is a quadratic in t. Real roots
 * with t in [0, 1] are intersections on that segment.
 *
 * Returns 0, 1, or 2 intersections per segment, in segment order.
 *
 * Tangent contacts (discriminant ≈ 0) count as a single intersection.
 * Numerical tolerance: discriminant > -ε is treated as ≥ 0 to avoid
 * missing tangents from FP drift.
 */
export function findCircleProfileIntersections(
  centerS: number,
  centerY: number,
  radius: number,
  curve: readonly ProfileVertex[],
): ProfileIntersection[] {
  const out: ProfileIntersection[] = [];
  const R2 = radius * radius;
  const T_EPS = 1e-9; // tolerance for "t in [0, 1]"
  for (let i = 0; i + 1 < curve.length; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    const ds = b.s - a.s;
    const dy = b.y - a.y;
    const A = ds * ds + dy * dy;
    if (A < 1e-12) continue; // degenerate (zero-length segment)
    const ox = a.s - centerS;
    const oy = a.y - centerY;
    const B = 2 * (ox * ds + oy * dy);
    const C = ox * ox + oy * oy - R2;
    const disc = B * B - 4 * A * C;
    // Relative-scale tangent tolerance: B² and 4AC each scale as A·R² for a
    // tangent contact, so cancellation can leave a discriminant on the order
    // of A·R²·machine-epsilon. Treat |disc| ≲ that scale as exactly tangent.
    const discScale = Math.abs(B * B) + Math.abs(4 * A * C);
    const TANGENT_EPS = 1e-10 * discScale + 1e-18;
    if (disc < -TANGENT_EPS) continue; // no real intersection
    const isTangent = disc < TANGENT_EPS;
    const sq = isTangent ? 0 : Math.sqrt(disc);
    const inv2A = 1 / (2 * A);
    const t1 = (-B - sq) * inv2A;
    if (t1 >= -T_EPS && t1 <= 1 + T_EPS) {
      const tc = Math.max(0, Math.min(1, t1));
      out.push({
        s: a.s + tc * ds,
        y: a.y + tc * dy,
        segmentIndex: i,
        t: tc,
      });
    }
    if (isTangent) continue; // single tangent root already recorded
    const t2 = (-B + sq) * inv2A;
    if (t2 >= -T_EPS && t2 <= 1 + T_EPS) {
      const tc = Math.max(0, Math.min(1, t2));
      out.push({
        s: a.s + tc * ds,
        y: a.y + tc * dy,
        segmentIndex: i,
        t: tc,
      });
    }
  }
  return out;
}
