/**
 * Analytical continuous collision detection for a disc rolling on a
 * piecewise-linear curve (= bilinear heightmap sliced in the velocity plane).
 *
 * Each tick the body's UV advances via velocity·tangent (the existing
 * surface-led integration). When the resulting predicted disc-center would
 * pass through a NEW surface segment (multi-contact corner) before reaching
 * the predicted UV, this module detects the transition analytically and
 * iteratively rolls the disc through:
 *
 *   for each iteration:
 *     1. Sweep disc from current 2D position toward current + velocity·remaining_dt.
 *     2. For each segment NOT in the rolling path [s1, s2], analytically solve
 *        the earliest sweep parameter τ ∈ [0, 1] where the disc circle first
 *        touches the segment (line equation for interior contact + quadratic
 *        for endpoint vertex contact).
 *     3. Smallest τ across segments → contact moment.
 *     4. Move disc to that τ; rotate velocity onto new segment's tangent ×
 *        cornerTransferEfficiency. No drop-normal step (velocity is tangent
 *        in surface space; the rotation IS the only operation).
 *     5. Repeat with remaining time.
 *
 * Pure 2D math in the velocity plane spanned by `(velocity_horizontal,
 * gravity_up)`. World ↔ 2D conversion happens at the boundary.
 *
 * Per user spec 2026-05-22.
 */

/** A vertex of the piecewise-linear profile in the velocity plane. */
export interface ProfileVertex {
  /** Arclength-equivalent: distance along the velocity-horizontal axis from the
   *  body's start-of-tick position. Negative = behind body. */
  s: number;
  /** World-Y at this s. */
  y: number;
}

/** Result of the analytical sweep against a single segment. */
export interface SweepHit {
  /** Sweep parameter ∈ [0, 1] at which the disc first touches the segment. */
  tau: number;
  /** Index of the hit segment in the profile array (segment i = profile[i]→profile[i+1]). */
  segmentIndex: number;
  /** Disc center at the contact moment, in profile (s, y) coords. */
  centerS: number;
  centerY: number;
  /** Unit segment direction (in 2D plane) at the contact. */
  tangentS: number;
  tangentY: number;
}

const PARALLEL_EPS = 1e-9;
const TAU_EPS = 1e-9;
/**
 * Minimum sweep parameter to count as a NEW contact. Hits with τ < TAU_MIN
 * are treated as "disc already in contact at start of sweep" (= the
 * current rolling/pivot segment) and ignored. This handles the case where
 * the disc is tangent to multiple segments simultaneously at the moment
 * of a corner pivot: only segments the disc enters DURING the sweep are
 * candidates for a new transition.
 */
const TAU_MIN = 1e-6;

/**
 * Smallest τ ∈ [0, 1] at which a disc of radius R, swept from `(cs, cy)`
 * along `(vs, vy)`, first touches the segment from `(ax, ay)` to `(bx, by)`.
 *
 * Returns null if the disc misses the segment during the sweep.
 *
 * Handles both interior (line) contact and endpoint (vertex) contact.
 */
export function sweepCircleVsSegment(
  cs: number, cy: number,
  vs: number, vy: number,
  R: number,
  ax: number, ay: number,
  bx: number, by: number,
): number | null {
  const abx = bx - ax;
  const aby = by - ay;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 < PARALLEL_EPS) {
    return solveEndpointQuad(cs, cy, vs, vy, R, ax, ay);
  }
  const abLen = Math.sqrt(abLen2);
  const dx = abx / abLen;
  const dy = aby / abLen;
  const nx = -dy;
  const ny = dx;

  const dist0 = (cs - ax) * nx + (cy - ay) * ny;
  const dDist = vs * nx + vy * ny;

  let lineTau: number | null = null;
  if (Math.abs(dDist) >= PARALLEL_EPS) {
    const sign = dist0 >= 0 ? 1 : -1;
    const tau = (sign * R - dist0) / dDist;
    if (tau >= TAU_MIN && tau <= 1 + TAU_EPS) {
      const ccs = cs + tau * vs;
      const ccy = cy + tau * vy;
      const segParam = (ccs - ax) * dx + (ccy - ay) * dy;
      if (segParam >= -TAU_EPS && segParam <= abLen + TAU_EPS) {
        lineTau = tau;
      }
    }
  }

  const tauA = solveEndpointQuad(cs, cy, vs, vy, R, ax, ay);
  const tauB = solveEndpointQuad(cs, cy, vs, vy, R, bx, by);

  let best: number | null = null;
  if (lineTau !== null) best = lineTau;
  if (tauA !== null && (best === null || tauA < best)) best = tauA;
  if (tauB !== null && (best === null || tauB < best)) best = tauB;
  return best;
}

/**
 * Quadratic solve: smallest τ ∈ [0, 1] where |C(τ) − P| = R, with
 * C(τ) = (cs + τvs, cy + τvy) and P = (px, py).
 *
 *   |C(τ) − P|² = R²
 *   |displacement|²·τ² + 2·D·displacement·τ + (|D|² − R²) = 0  where D = C(0) − P.
 *
 * Returns null if discriminant < 0 (no contact), or no root in [0, 1].
 * Picks the smaller root (= first contact, where the circle's surface
 * arrives at the vertex).
 */
function solveEndpointQuad(
  cs: number, cy: number,
  vs: number, vy: number,
  R: number,
  px: number, py: number,
): number | null {
  const Dx = cs - px;
  const Dy = cy - py;
  const a = vs * vs + vy * vy;
  if (a < PARALLEL_EPS) return null;
  const b = Dx * vs + Dy * vy;
  const c = Dx * Dx + Dy * Dy - R * R;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  const t0 = (-b - sqrtDisc) / a;
  if (t0 >= TAU_MIN && t0 <= 1 + TAU_EPS) return t0;
  const t1 = (-b + sqrtDisc) / a;
  if (t1 >= TAU_MIN && t1 <= 1 + TAU_EPS) return t1;
  return null;
}

/**
 * Sweep a disc through a piecewise-linear profile and return the first
 * contact (smallest τ) across all eligible segments. The segment indexed
 * by `skipSegmentIndex` is excluded — that's the segment the disc is
 * currently tangent to (= previous contact, or the initial rolling
 * segment under the body's foot). Pass `-1` to skip none.
 *
 * Returns null if no segment is hit during the sweep.
 */
export function sweepDiscAgainstProfile(
  cs: number, cy: number,
  vs: number, vy: number,
  R: number,
  profile: readonly ProfileVertex[],
  skipSegmentIndex: number,
): SweepHit | null {
  let best: SweepHit | null = null;
  for (let i = 0; i < profile.length - 1; i++) {
    if (i === skipSegmentIndex) continue;
    const A = profile[i];
    const B = profile[i + 1];
    const tau = sweepCircleVsSegment(cs, cy, vs, vy, R, A.s, A.y, B.s, B.y);
    if (tau === null) continue;
    if (best === null || tau < best.tau) {
      const ccs = cs + tau * vs;
      const ccy = cy + tau * vy;
      const dxs = B.s - A.s;
      const dys = B.y - A.y;
      const dLen = Math.hypot(dxs, dys);
      const tangentS = dLen > 0 ? dxs / dLen : 1;
      const tangentY = dLen > 0 ? dys / dLen : 0;
      best = { tau, segmentIndex: i, centerS: ccs, centerY: ccy, tangentS, tangentY };
    }
  }
  return best;
}

/**
 * Iteratively sweep a disc along its velocity for a full tick of duration
 * `dt`. On each iteration, find the earliest segment contact; if none,
 * smooth roll completes the remaining time; if found, rotate velocity onto
 * the contact segment's tangent direction (scaled by `transferEfficiency`)
 * and continue with the remaining time.
 *
 * `skipSMin`/`skipSMax` is the initial rolling-path range — segments inside
 * are skipped on the FIRST iteration only (the disc is already tangent to
 * them). Subsequent iterations don't skip anything; the previous-contact
 * segment is naturally rejected because the disc starts tangent to it and
 * the sweep direction moves away.
 *
 * `maxIterations` is the safety cap. In normal play 0-2 transitions per
 * tick is expected; hitting the cap should be loud (caller asserts).
 *
 * Returns the final disc center, final 2D velocity, and number of contact
 * transitions taken.
 */
export interface IterativeSweepResult {
  /** Final disc center (s, y) after all iterations. */
  centerS: number;
  centerY: number;
  /** Final 2D velocity (vs, vy) after all tangent rotations. */
  velS: number;
  velY: number;
  /** Number of segment-contact transitions taken (0 = smooth roll). */
  transitions: number;
  /** Index of the segment the disc is tangent to at the end of the
   *  iteration. Smooth-roll: same as `initialContactSegmentIndex`. After
   *  one or more transitions: the last segment the disc rolled onto. */
  finalSegmentIndex: number;
  /** True if maxIterations was hit without consuming all dt. Caller should
   *  treat this as a bug. */
  hitIterationCap: boolean;
}

export function iterateDiscSweep(
  initialCenterS: number, initialCenterY: number,
  initialVelS: number, initialVelY: number,
  R: number,
  profile: readonly ProfileVertex[],
  initialContactSegmentIndex: number,
  dt: number,
  transferEfficiency: number,
  maxIterations: number = 4,
): IterativeSweepResult {
  let cs = initialCenterS;
  let cy = initialCenterY;
  let vs = initialVelS;
  let vy = initialVelY;
  let remaining = dt;
  let transitions = 0;
  let skipSegmentIndex = initialContactSegmentIndex;

  for (let iter = 0; iter < maxIterations; iter++) {
    const sweepVs = vs * remaining;
    const sweepVy = vy * remaining;
    const sweepLen = Math.hypot(sweepVs, sweepVy);
    if (sweepLen < TAU_EPS) {
      return { centerS: cs, centerY: cy, velS: vs, velY: vy, transitions, finalSegmentIndex: skipSegmentIndex, hitIterationCap: false };
    }
    const hit = sweepDiscAgainstProfile(cs, cy, sweepVs, sweepVy, R, profile, skipSegmentIndex);
    if (hit === null) {
      cs += sweepVs;
      cy += sweepVy;
      return { centerS: cs, centerY: cy, velS: vs, velY: vy, transitions, finalSegmentIndex: skipSegmentIndex, hitIterationCap: false };
    }
    cs = hit.centerS;
    cy = hit.centerY;
    const speed = Math.hypot(vs, vy);
    const projection = vs * hit.tangentS + vy * hit.tangentY;
    const tangentSign = projection >= 0 ? 1 : -1;
    const targetSpeed = speed * transferEfficiency;
    vs = tangentSign * targetSpeed * hit.tangentS;
    vy = tangentSign * targetSpeed * hit.tangentY;
    remaining = remaining * (1 - hit.tau);
    transitions++;
    skipSegmentIndex = hit.segmentIndex;
  }
  return { centerS: cs, centerY: cy, velS: vs, velY: vy, transitions, finalSegmentIndex: skipSegmentIndex, hitIterationCap: true };
}

/**
 * Sample the bilinear heightmap surface along a horizontal direction in the
 * velocity plane, producing a piecewise-linear profile in (s, y) coords.
 *
 * `bodyX, bodyZ` is the world XZ origin for s=0. The profile extends from
 * `-halfBack` to `+halfFwd` in s, sampled uniformly at `step` intervals.
 * `dirX, dirZ` is the horizontal velocity direction (unit vector in world XZ).
 */
export function sliceProfileAlongVelocity(
  sampleHeight: (worldX: number, worldZ: number) => number,
  bodyX: number, bodyZ: number,
  dirX: number, dirZ: number,
  halfBack: number, halfFwd: number,
  step: number,
): ProfileVertex[] {
  const samples: ProfileVertex[] = [];
  const sMin = -halfBack;
  const sMax = halfFwd;
  for (let s = sMin; s <= sMax + step * 0.5; s += step) {
    const sClamped = Math.min(s, sMax);
    const wx = bodyX + sClamped * dirX;
    const wz = bodyZ + sClamped * dirZ;
    samples.push({ s: sClamped, y: sampleHeight(wx, wz) });
  }
  return mergeCollinearSegments(samples);
}

/**
 * Collapse runs of collinear adjacent segments in a piecewise-linear
 * profile into single segments. Two adjacent segments `(A→B), (B→C)` are
 * collinear iff the cross product of their direction vectors is below
 * `1e-6 · |AB| · |BC|` (relative tolerance — handles uniformly-sampled
 * flat or wall regions where the sample points lie on the same line).
 *
 * Without this collapse, sweeping a disc up a long wall would register
 * a "transition" at every internal sample joint (= every step·tangent
 * unit), each halving the velocity by `cornerTransferEfficiency` even
 * though the disc is rolling smoothly along a single straight segment.
 */
export function mergeCollinearSegments(profile: readonly ProfileVertex[]): ProfileVertex[] {
  if (profile.length < 3) return [...profile];
  const result: ProfileVertex[] = [profile[0]];
  for (let i = 1; i < profile.length - 1; i++) {
    const prev = result[result.length - 1];
    const cur = profile[i];
    const next = profile[i + 1];
    const d1s = cur.s - prev.s;
    const d1y = cur.y - prev.y;
    const d2s = next.s - cur.s;
    const d2y = next.y - cur.y;
    const cross = d1s * d2y - d1y * d2s;
    const len1 = Math.hypot(d1s, d1y);
    const len2 = Math.hypot(d2s, d2y);
    if (Math.abs(cross) > 1e-6 * len1 * len2 || len1 < 1e-12 || len2 < 1e-12) {
      result.push(cur);
    }
  }
  result.push(profile[profile.length - 1]);
  return result;
}
