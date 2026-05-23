/**
 * Analytical swept-circle-vs-segment intersection in 2D.
 *
 * Given a disc of radius R centered at (cs, cy) sweeping by displacement
 * (vs, vy), find the smallest sweep parameter τ ∈ (0, 1] at which the
 * disc circle first touches the segment from (ax, ay) to (bx, by).
 *
 * Used by the surface-constrained controller's iterative corner-jump
 * loop: each iteration sweeps the disc against profile segments outside
 * the current rolling path and picks the smallest τ across all of them
 * as the next contact transition.
 *
 * Pure 2D math — no surface knowledge, no buffer access. Lib layer.
 *
 * Two contact modes are checked per segment:
 *
 *   1. Interior contact (line): solve `dist(τ) = ±R` where `dist` is the
 *      signed perpendicular distance from C(τ) to the segment's line.
 *      Linear in τ. Verify the closest point at τ lies in [A, B].
 *
 *   2. Endpoint contact (vertex): solve `|C(τ) − A|² = R²` (and same for
 *      B). Quadratic in τ. Take smallest non-negative root in (TAU_MIN, 1].
 *
 * Returns min τ across both modes, or `null` if no contact during sweep.
 *
 * The TAU_MIN > 0 filter rejects "disc already in contact at τ=0" hits
 * which would otherwise cause infinite loops in the iteration driver
 * (= disc tangent at start should not register as a new transition).
 */

/**
 * Minimum sweep parameter to count as a NEW contact. The default −1e-9
 * accepts τ=0 hits — which IS the multi-contact moment when sweeping
 * against a non-skip segment (= disc center is already at distance R from
 * the segment at the start of the sweep, meaning the disc is
 * simultaneously tangent to its current skip segment AND the segment we're
 * testing). Allowing τ=0 here is what makes the corner-jump CCD detect the
 * exact moment a UV-led foot crosses a cell-boundary vertex without the
 * disc center jumping by R·|N_left − N_right|.
 *
 * The tiny negative tolerance absorbs floating-point noise around the
 * exact multi-contact configuration; a strict τ ≥ 0 would intermittently
 * miss valid multi-contact moments due to 1e-15-scale rounding.
 */
export const TAU_MIN = -1e-9;

/**
 * Smallest τ ∈ [TAU_MIN, 1] where the swept disc first touches segment
 * AB, or null if no contact during the sweep.
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
  if (abLen2 < 1e-18) {
    return solveEndpointQuad(cs, cy, vs, vy, R, ax, ay);
  }
  const abLen = Math.sqrt(abLen2);
  const dx = abx / abLen;
  const dy = aby / abLen;
  // 2D perpendicular (rotate dir 90° CCW). For a sliced heightmap profile
  // (segments advancing in +s direction), this gives an outward normal
  // with non-negative y-component — disc is above the profile.
  const nx = -dy;
  const ny = dx;

  const dist0 = (cs - ax) * nx + (cy - ay) * ny;
  const dDist = vs * nx + vy * ny;

  let lineTau: number | null = null;
  if (Math.abs(dDist) >= 1e-12) {
    const sign = dist0 >= 0 ? 1 : -1;
    const tau = (sign * R - dist0) / dDist;
    if (tau > TAU_MIN && tau <= 1 + 1e-9) {
      // Verify closest point at τ lies within segment [A, B].
      const ccs = cs + tau * vs;
      const ccy = cy + tau * vy;
      const segParam = (ccs - ax) * dx + (ccy - ay) * dy;
      if (segParam >= -1e-9 && segParam <= abLen + 1e-9) {
        lineTau = Math.min(1, tau);
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
 * Solve |C(τ) − (px, py)|² = R² for smallest τ ∈ (TAU_MIN, 1].
 * Quadratic in τ with disc-vs-vertex contact semantics.
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
  if (a < 1e-18) return null;  // zero sweep displacement
  const b = Dx * vs + Dy * vy;
  const c = Dx * Dx + Dy * Dy - R * R;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const sqrtDisc = Math.sqrt(disc);
  // Smaller root = first contact (disc surface arrives at vertex).
  const t0 = (-b - sqrtDisc) / a;
  if (t0 > TAU_MIN && t0 <= 1 + 1e-9) return Math.min(1, t0);
  const t1 = (-b + sqrtDisc) / a;
  if (t1 > TAU_MIN && t1 <= 1 + 1e-9) return Math.min(1, t1);
  return null;
}
