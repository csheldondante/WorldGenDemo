/**
 * Linear acceleration curves: max producible acceleration as a function of
 * current velocity in that direction.
 *
 * Plain data — see DOD rule #1. A curve has two numbers: the max accel at
 * zero velocity, and the velocity at which max accel reaches zero. Linear
 * interpolation between them; clamped to [0, accelAtZero] outside.
 *
 * The user's framing (from the vision overview): external accelerations
 * "shift the curve up or down." On a downhill slope, gravity along the
 * slope adds to the available forward accel, raising the speed at which
 * the available accel reaches zero — so equilibrium speed exceeds vMax.
 * On uphill, gravity opposes thrust, lowering the equilibrium below vMax.
 * The leave-surface rule (Phase 4) reads the down-accel curve at the
 * current normal velocity to get a grip budget that degrades during
 * impacts rather than snapping off at a hard cap.
 *
 * No runtime / framework deps — lives in `src/lib/math/` per the layer
 * rules in `src/lib/CLAUDE.md`.
 */

export type LinearAccelCurve = {
  /** Max accel producible when current velocity in this direction is 0 (m/s²). */
  accelAtZero: number;
  /** Velocity at which max accel reaches zero — slope of the line is −accelAtZero / vMax (m/s). */
  vMax: number;
};

/**
 * Evaluate the biomechanical curve at the given velocity in the curve's reference
 * direction.
 *   currentV ≤ 0      → accelAtZero (full thrust; the opposing-direction curve
 *                       handles motion in the opposite direction)
 *   0 < currentV < vMax → linear: accelAtZero · (1 − currentV/vMax)
 *   currentV ≥ vMax   → NEGATIVE: accelAtZero · (1 − currentV/vMax)
 *
 * Important: past `vMax` the curve returns negative values. This represents
 * "limbs cannot push at this speed and actively drag" — necessary so that
 * external accel can shift the curve up and produce a higher x-intercept
 * (faster sustainable speed) on downhills / tailwinds. Clamping to 0 here
 * would defeat the "external shifts x-intercept" property and pin the
 * character at vMax regardless of helpful external forces.
 */
export function evaluateLinearAccel(curve: LinearAccelCurve, currentV: number): number {
  if (currentV <= 0) return curve.accelAtZero;
  return curve.accelAtZero * (1 - currentV / curve.vMax);
}

/**
 * X-intercept of the curve after a vertical shift by `externalAccel`.
 * Solves `accelAtZero · (1 − v/vMax) + externalAccel = 0` for v:
 *   v = vMax · (1 + externalAccel / accelAtZero)
 *
 * Interpretation: this is the speed at which "biomechanical thrust + external
 * accel" balances to zero net accel along the curve's reference direction —
 * the character's maximum sustainable speed given the current external forces.
 * Tailwind / downhill pushes it past vMax; headwind / uphill pulls it below.
 *
 * Returns max(0, …) so callers don't have to handle negative speeds. A negative
 * x-intercept means external is so adversarial the character can't even sustain
 * standing still in this direction — they'd be pushed backward. Caller can
 * treat 0 as "no positive desired speed available."
 */
export function xInterceptShifted(curve: LinearAccelCurve, externalAccel: number): number {
  if (!Number.isFinite(curve.vMax)) return Number.POSITIVE_INFINITY;
  const v = curve.vMax * (1 + externalAccel / curve.accelAtZero);
  return v > 0 ? v : 0;
}
