/**
 * Held-impulse progress kernel.
 *
 * Pattern: a button-press fires an impulse along a fixed direction; the
 * player can hold the button to apply more of the total impulse budget
 * over a short time window. The caller stores `(dir, max, applied)` on
 * its own buffer; this kernel computes what fraction of the budget
 * should have been applied by now, as a pure function of elapsed press
 * time. The caller then derives `delta = progress × max − applied` and
 * applies it.
 *
 * Two design properties this function preserves:
 *
 * 1. **Frame-rate independence.** Progress is purely a function of
 *    elapsed time, not of how many ticks fired. The same total
 *    press-duration produces the same total impulse regardless of
 *    `dt`. Critical for tick-rate-sensitive feel mechanics.
 *
 * 2. **Optional step-snapping.** When `stepCount > 1`, progress is
 *    discretized into N equal-energy quanta. Players can time their
 *    presses to hit specific steps for predictable outcomes — turns a
 *    fuzzy analog timing skill into a discrete one. `stepCount <= 1`
 *    falls back to linear continuous progress.
 *
 * Use cases anticipated: jump hold (current), ground-pound charge,
 * dash charge, wallRun grip-decay, ranged-attack charge.
 *
 * Runtime-agnostic per src/lib/CLAUDE.md.
 */

/**
 * Returns the fraction of the impulse budget that should have been
 * applied at elapsed press-time `tHeld`. Range: [0, 1]. Caller
 * multiplies by the total budget to get the target absolute amount,
 * then applies (target − applied_so_far) along the impulse direction.
 *
 * - `tHeld <= 0` → 1/stepCount (stepped) or 0 (continuous).
 * - `tHeld >= holdMaxSec` → 1.
 * - `holdMaxSec <= 0` → 1 (degenerate; treat as "all applied immediately").
 * - `stepCount <= 1` → linear `clamp(tHeld / holdMaxSec, 0, 1)`.
 * - `stepCount > 1` → step k complete at `tHeld = k × holdMaxSec / stepCount`,
 *   so progress reads as `min(k, stepCount) / stepCount` where
 *   `k = floor(tHeld × stepCount / holdMaxSec) + 1`.
 */
export function heldImpulseProgress(
  tHeld: number,
  holdMaxSec: number,
  stepCount: number,
): number {
  if (holdMaxSec <= 0) return 1;
  if (stepCount <= 1) {
    const p = tHeld / holdMaxSec;
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    return p;
  }
  const stepIdx = Math.min(stepCount, Math.floor(tHeld * stepCount / holdMaxSec) + 1);
  if (stepIdx <= 0) return 0;
  return stepIdx / stepCount;
}
