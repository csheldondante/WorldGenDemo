/**
 * Continuous collision detection: sphere swept along a constant-acceleration
 * arc, against a height-field surface.
 *
 * Per-frame airborne integration follows
 *
 *     p(t) = p0 + v0·t + ½·a·t²        (t ∈ [0, dt])
 *
 * with `a` = gravity + other external accel held constant for the frame.
 * The classic "advance position by `v·dt`" integration can place the body
 * inside terrain in a single tick when |v| is large compared to local
 * surface curvature — at 10 m/s and dt=0.016s the body moves 16 cm per
 * frame; a thin terrain wall can be passed entirely.
 *
 * This module walks the arc in small substeps and reports the first time
 * the sphere touches the surface (signed distance ≤ 0), bisecting between
 * the last "outside" sample and the first "inside" sample to refine the
 * hit time.
 *
 * Generality: takes a `heightQuery(x, z) → number | null` callback for the
 * terrain. The caller wires it to whatever SurfaceProvider applies. For the
 * HeightmapSurfaceProvider that's `sample.position[1]` (height) at the
 * world (x, z) sampled via `worldToUV` + `sampleAtUV`.
 *
 * Runtime-agnostic per src/lib/CLAUDE.md — no `three`, no buffers.
 */

import type { Vec3 } from "../math/quat";

export interface ArcSweepHit {
  /** Time of first contact, t ∈ (0, dt]. */
  t: number;
  /** World-space body centre at the contact time. */
  point: Vec3;
  /** Outward unit surface normal at the contact point. */
  normal: Vec3;
}

/**
 * Heightmap query function. Returns terrain height at world (x, z), or
 * `null` if (x, z) is outside the surface's defined region (caller's
 * choice — usually means "no terrain here, no collision possible").
 *
 * Includes the normal at the same point so the sweep doesn't need a
 * second query to populate the hit normal.
 */
export interface HeightSurfaceQuery {
  (x: number, z: number): { height: number; normal: Vec3 } | null;
}

const DEFAULT_SUBSTEPS = 8;
const DEFAULT_BISECTION_ITERS = 6;

/**
 * Find the smallest t in (0, dt] where the sphere of radius `radius`
 * following the constant-accel arc first touches the surface (body bottom
 * ≤ terrain height at body's XZ position). Returns null if no contact
 * within the frame.
 *
 * The signed distance `f(t) = p(t).y − radius − h(p(t).x, p(t).z)` is
 * sampled at N+1 substep boundaries. The first sub-interval [tᵢ, tᵢ₊₁]
 * where `f(tᵢ) > 0` and `f(tᵢ₊₁) ≤ 0` is bisected to refine `t*`.
 *
 * If `f(0) ≤ 0` (body already embedded at frame start), returns a
 * hit at t = 0 — caller must push the body out along the normal.
 *
 * If `heightQuery` returns null at any substep (body has flown outside
 * the surface region), that substep is treated as "no terrain → no
 * contact possible." The sweep continues past it.
 */
export function sweepSphereVsHeightSurface(
  p0: Vec3,
  v0: Vec3,
  a: Vec3,
  dt: number,
  radius: number,
  heightQuery: HeightSurfaceQuery,
  substeps: number = DEFAULT_SUBSTEPS,
  bisectionIters: number = DEFAULT_BISECTION_ITERS,
): ArcSweepHit | null {
  const evalAt = (t: number): { p: Vec3; h: { height: number; normal: Vec3 } | null } => {
    const t2 = 0.5 * t * t;
    const p: Vec3 = [
      p0[0] + v0[0] * t + a[0] * t2,
      p0[1] + v0[1] * t + a[1] * t2,
      p0[2] + v0[2] * t + a[2] * t2,
    ];
    return { p, h: heightQuery(p[0], p[2]) };
  };

  // f(t) = p(t).y - radius - terrain_height_at(p.x, p.z). Negative = inside.
  // Null terrain (outside surface region) is treated as "+Infinity" — never inside.
  const f = (sample: { p: Vec3; h: { height: number; normal: Vec3 } | null }): number => {
    if (!sample.h) return Number.POSITIVE_INFINITY;
    return sample.p[1] - radius - sample.h.height;
  };

  let prev = evalAt(0);
  let prevF = f(prev);
  if (prevF <= 0) {
    // Already embedded at t=0 — return immediate hit. Caller resolves by
    // pushing the body out along the normal.
    if (!prev.h) {
      // Defensive: shouldn't happen since prevF <= 0 implies a valid query.
      return null;
    }
    return { t: 0, point: prev.p, normal: prev.h.normal };
  }

  for (let i = 1; i <= substeps; i++) {
    const tCurr = (i / substeps) * dt;
    const curr = evalAt(tCurr);
    const currF = f(curr);
    if (currF <= 0) {
      // Sign change between (prev, curr). Bisect to refine.
      const tPrev = ((i - 1) / substeps) * dt;
      let lo = tPrev;
      let hi = tCurr;
      let loF = prevF;
      // hiF not stored; recomputed inside the loop.
      for (let k = 0; k < bisectionIters; k++) {
        const mid = (lo + hi) * 0.5;
        const sample = evalAt(mid);
        const midF = f(sample);
        if (midF > 0) {
          lo = mid;
          loF = midF;
        } else {
          hi = mid;
        }
        void loF;
      }
      // Use the high end (just-inside) as the contact estimate.
      const sample = evalAt(hi);
      if (!sample.h) {
        // Edge case: query returned null at the just-inside sample. Skip.
        prev = curr;
        prevF = currF;
        continue;
      }
      return { t: hi, point: sample.p, normal: sample.h.normal };
    }
    prev = curr;
    prevF = currF;
  }

  return null;
}
