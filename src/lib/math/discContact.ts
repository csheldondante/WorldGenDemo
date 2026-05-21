/**
 * Resolve a disc's center position from its contacts with a piecewise-linear
 * surface profile in 2D (the body's velocity plane).
 *
 * The body is modeled as a disc of radius R rolling in the velocity plane;
 * the surface profile is the heightmap restricted to that plane. The
 * upstream `findCircleProfileIntersections` returns all points where the
 * disc circle crosses the profile; this module turns those into a single
 * canonical disc center via:
 *
 *   - **1 contact (smooth roll)**: disc tangent to a single segment.
 *     center = contact + R · outward_normal(segment).
 *   - **2 contacts on different segments (concave corner)**: disc tucks
 *     into the corner. The unique 2D point at distance R from both
 *     segments is the intersection of the two offset lines (each parallel
 *     to its segment, offset by R in the outward direction). Falls
 *     through to "single contact tangent" if the segments are parallel
 *     (no real corner).
 *   - **2 contacts on the same segment (embedded chord)**: disc has
 *     sunk into one segment. Pop the disc out perpendicular to the
 *     segment until tangent (single contact case).
 *   - **3+ distinct contacts**: pick the two most-extreme `s` values
 *     (smallest + largest) and resolve as the 2-contact case. Real
 *     multi-segment corners are rare in current scenes.
 *
 * The "outward normal" of each segment is the perpendicular to its
 * direction that points AWAY from the surface — assuming the body is
 * above the profile, that's the perpendicular with positive y component.
 *
 * Pure 2D. Lib-layer module — no runtime / DOM / Three.js deps.
 */

import type { ProfileVertex, ProfileIntersection } from "./wheelIntersect";

/** Resolved disc center in the (s, y) velocity plane, with the contact
 *  normal the integrator should use for velocity projection. */
export interface DiscContactResolution {
  /** Disc-center position in the (s, y) plane. */
  centerS: number;
  centerY: number;
  /** Contact normal pointing away from the surface (into where the disc
   *  lives), unit length. For single-contact cases this is the outward
   *  normal of the contact segment. For corner cases it's the bisector
   *  of the two segment normals (= direction from corner vertex to disc
   *  center, normalized). Used for velocity reprojection. */
  normalS: number;
  normalY: number;
  /** Classification — useful for diagnostics and tests. */
  kind: "tangent" | "corner" | "pop-out" | "fallback-parallel";
}

const PARALLEL_EPS = 1e-6;
/**
 * Minimum cos(angle) between the two segments' outward normals for the
 * circumcenter math to fire. Above this threshold the segments are
 * "nearly collinear" (small slope change) — the determinant in the
 * offset-line intersection is small but non-zero, so naively solving for
 * tA produces a wildly off-position circumcenter (tA blows up as det
 * shrinks). Fall through to single-tangent in that regime; the result
 * stays continuous as slope-change → 0.
 *
 * cos(5°) ≈ 0.9962. Real concave corners on heightmap cell boundaries
 * have slope changes of tens of degrees; sub-cell sampling artifacts
 * sit well above 0.9962 and are correctly rejected.
 */
const NEAR_PARALLEL_COS = 0.9962;

/**
 * Resolve contacts into a single disc center. Returns `null` when the disc
 * has no contacts (body is airborne — caller flags detach).
 *
 * `R` is the disc radius. `intersections` come from
 * `findCircleProfileIntersections(centerS, centerY, R, profile)` and may be
 * empty; this routine deduplicates and selects internally.
 */
export function resolveDiscContacts(
  intersections: readonly ProfileIntersection[],
  profile: readonly ProfileVertex[],
  R: number,
): DiscContactResolution | null {
  if (intersections.length === 0) return null;

  // Deduplicate "same point" intersections that the upstream solver may
  // emit at shared segment vertices (one segment's t=1 = the next
  // segment's t=0). The dedupe key is (s, y) within 1e-6.
  const distinct: ProfileIntersection[] = [];
  for (const isct of intersections) {
    let dup = false;
    for (const kept of distinct) {
      if (
        Math.abs(isct.s - kept.s) < 1e-6 &&
        Math.abs(isct.y - kept.y) < 1e-6
      ) {
        dup = true;
        break;
      }
    }
    if (!dup) distinct.push(isct);
  }

  if (distinct.length === 1) {
    return resolveTangent(distinct[0], profile, R);
  }

  if (distinct.length === 2) {
    return resolveTwo(distinct[0], distinct[1], profile, R);
  }

  // 3+ contacts: pick the two extremes in s, treat as 2-contact case.
  let lo = distinct[0];
  let hi = distinct[0];
  for (const isct of distinct) {
    if (isct.s < lo.s) lo = isct;
    if (isct.s > hi.s) hi = isct;
  }
  return resolveTwo(lo, hi, profile, R);
}

// ---------------------------------------------------------------------------
// Segment geometry helpers (private)
// ---------------------------------------------------------------------------

interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Unit direction along the segment from A to B. */
  dx: number;
  dy: number;
  /** Unit outward normal (perpendicular to direction, pointing +y-ish — away from the surface below). */
  nx: number;
  ny: number;
}

function buildSegment(p: ProfileVertex, q: ProfileVertex): Segment | null {
  const dx = q.s - p.s;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Outward normal: rotate direction 90° CCW gives (-uy, ux). For a profile
  // where the surface is below the body, the outward normal should have a
  // positive y component — flip if needed.
  let nx = -uy;
  let ny = ux;
  if (ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { ax: p.s, ay: p.y, bx: q.s, by: q.y, dx: ux, dy: uy, nx, ny };
}

function resolveTangent(
  isct: ProfileIntersection,
  profile: readonly ProfileVertex[],
  R: number,
): DiscContactResolution {
  const seg =
    buildSegment(profile[isct.segmentIndex], profile[isct.segmentIndex + 1]) ??
    // Degenerate zero-length segment — should not happen but fall back gracefully.
    { ax: isct.s, ay: isct.y, bx: isct.s, by: isct.y, dx: 1, dy: 0, nx: 0, ny: 1 };
  return {
    centerS: isct.s + R * seg.nx,
    centerY: isct.y + R * seg.ny,
    normalS: seg.nx,
    normalY: seg.ny,
    kind: "tangent",
  };
}

function resolveTwo(
  a: ProfileIntersection,
  b: ProfileIntersection,
  profile: readonly ProfileVertex[],
  R: number,
): DiscContactResolution {
  // Same segment → embedded chord case.
  if (a.segmentIndex === b.segmentIndex) {
    return resolvePopOut(a, b, profile, R);
  }

  const segA = buildSegment(profile[a.segmentIndex], profile[a.segmentIndex + 1]);
  const segB = buildSegment(profile[b.segmentIndex], profile[b.segmentIndex + 1]);
  if (!segA || !segB) {
    // Degenerate segment — use the simpler tangent of whichever's valid,
    // preferring the forward one.
    return resolveTangent(a.s > b.s ? a : b, profile, R);
  }

  // Convex-vs-concave discrimination. A disc rolling on a piecewise-linear
  // profile can have multiple contacts ONLY on CONCAVE curves whose local
  // radius of curvature is sharper than the disc radius R. Convex curves
  // (curve bending away from the disc) geometrically support only a single
  // contact; if findCircleProfileIntersections returned 2 chord points
  // around a convex apex, that is a profile-sampling artifact (the disc
  // has briefly penetrated the apex). The correct resolution is to treat
  // it as a single tangent on the higher contact side, NOT to apply
  // concave-circumcenter math. Departure FROM a convex surface (e.g.
  // body launching off a hill peak at high tangent speed) is handled
  // separately by characterController's centripetal-detach rule, not by
  // this disc-collider.
  //
  // Sign convention: profile coords have `s` increasing left→right, disc
  // up = +y. Segments are constructed in ascending-s order so segment
  // direction has dx > 0. Cross product `segA.dir × segB.dir = segA.dx ·
  // segB.dy − segA.dy · segB.dx`:
  //   > 0 → counter-clockwise turn from A to B → CONCAVE (profile.y has
  //         a local minimum at the vertex; body sits in the cup).
  //   < 0 → clockwise turn from A to B → CONVEX (profile.y has a local
  //         maximum at the vertex; body sits on the apex).
  //   = 0 → collinear (degenerate; the near-parallel-normal check below
  //         will catch it).
  //
  // See [[worldgen-demo-disc-collider-convex-vs-concave-2026-05-21]].
  const segCross = segA.dx * segB.dy - segA.dy * segB.dx;
  if (segCross < 0) {
    // CONVEX configuration. Resolve as single tangent on the contact
    // with the higher profile.y (= the apex side). The resolveTangent
    // call places the disc R perpendicular to that segment at the
    // contact, which is the geometrically correct disc-on-convex
    // position. (Collinear segments — segCross = 0 — are handled by the
    // near-parallel-normal check below, preserving the prior fallback-
    // parallel behavior for them.)
    const apex = a.y >= b.y ? a : b;
    return resolveTangent(apex, profile, R);
  }

  // Near-parallel rejection. When the two segments' outward normals are
  // nearly aligned (slope change < ~5°), the offset-line intersection is
  // numerically ill-conditioned: the determinant scales as sin(slope-
  // change), and `tA = numerator / det` blows up. For small slope changes
  // the body's correct position is essentially the single-tangent
  // position; fall through. This eliminates sub-cell-sampling-artifact
  // "corners" inside a single bilinear heightmap cell, which were the
  // source of the climb-steep-wall teleport bug (2026-05-20).
  const normalDot = segA.nx * segB.nx + segA.ny * segB.ny;
  if (normalDot > NEAR_PARALLEL_COS) {
    const fallback = resolveTangent(a.s >= b.s ? a : b, profile, R);
    return { ...fallback, kind: "fallback-parallel" };
  }

  // Offset lines: parallel to each segment, displaced by R along the
  // outward normal. Intersect them. The corner-tucked disc center is the
  // unique point at distance R from both segment lines (signed positive
  // on the outward side).
  const A0x = segA.ax + R * segA.nx;
  const A0y = segA.ay + R * segA.ny;
  const B0x = segB.ax + R * segB.nx;
  const B0y = segB.ay + R * segB.ny;

  // Solve A0 + tA·dA = B0 + tB·dB. Matrix [dA.x, -dB.x; dA.y, -dB.y].
  const det = segA.dx * -segB.dy - -segB.dx * segA.dy;
  if (Math.abs(det) < PARALLEL_EPS) {
    // Truly parallel direction vectors (degenerate beyond the normal-dot
    // check above) — defensive fallthrough.
    const fallback = resolveTangent(a.s >= b.s ? a : b, profile, R);
    return { ...fallback, kind: "fallback-parallel" };
  }

  const tA =
    (-segB.dy * (B0x - A0x) - -segB.dx * (B0y - A0y)) / det;
  const centerS = A0x + tA * segA.dx;
  const centerY = A0y + tA * segA.dy;

  // Corner contact normal = bisector of the two segment outward normals,
  // = normalized direction from the corner vertex to the disc center.
  // Use the bisector (average normalized) for stability and orientation
  // consistency with single-contact tangents.
  let bnx = segA.nx + segB.nx;
  let bny = segA.ny + segB.ny;
  const bLen = Math.hypot(bnx, bny);
  if (bLen > 1e-9) {
    bnx /= bLen;
    bny /= bLen;
  } else {
    // Opposing normals — shouldn't happen for a real concave corner;
    // default to the forward segment's normal.
    bnx = (a.s >= b.s ? segA : segB).nx;
    bny = (a.s >= b.s ? segA : segB).ny;
  }

  return { centerS, centerY, normalS: bnx, normalY: bny, kind: "corner" };
}

function resolvePopOut(
  a: ProfileIntersection,
  b: ProfileIntersection,
  profile: readonly ProfileVertex[],
  R: number,
): DiscContactResolution {
  const seg = buildSegment(profile[a.segmentIndex], profile[a.segmentIndex + 1]);
  if (!seg) {
    return resolveTangent(a.s >= b.s ? a : b, profile, R);
  }
  // Chord midpoint on the segment.
  const midS = (a.s + b.s) / 2;
  const midY = (a.y + b.y) / 2;
  // Move the disc center to the TANGENT position above the chord midpoint.
  // The disc circle of radius R centered at (midpoint + R · outward_normal)
  // just kisses the segment at the chord midpoint — body fully popped out of
  // the surface, no penetration.
  //
  // (An earlier version of this function used perpDist = sqrt(R² − halfChord²)
  // here, which is the perpendicular distance from the chord midpoint to a
  // disc center whose CIRCLE STILL CROSSES the segment through the two chord
  // endpoints. That LEAVES the disc penetrating the segment, which is
  // physically wrong for "pop out". Over many ticks of small gravity-induced
  // penetration on flat ground, the body's center drifted ~g·dt² below R
  // per tick. Fixed 2026-05-20.)
  return {
    centerS: midS + R * seg.nx,
    centerY: midY + R * seg.ny,
    normalS: seg.nx,
    normalY: seg.ny,
    kind: "pop-out",
  };
}
