# Batch: Architecture split — Phase B.2.5 (shifted-x-intercept vDesired + subtract-external)

Date: 2026-05-15. Continues from `2026-05-15-architecture-split-b2.md`.

## Goal — make external accel actually shift the equilibrium speed

Realize the design rule in `wiki/worldgen-demo-accel-curve-and-desired-velocity.md`. Today the controller targets `desiredRunSpeed = 8` regardless of slope/wind/etc., and brakes itself to that target. Result: downhill running doesn't actually speed you up; uphill doesn't slow you down (controller fights gravity to a fixed target). After this batch: vDesired = x-intercept of the shifted accel curve, so external forces naturally raise or lower the target.

## Decisions

1. **`evaluateLinearAccel` unclamped past `vMax`.** It now returns negative values for `v > vMax`, representing "limbs drag — they can't push at this speed and instead decelerate." Without this the x-intercept of the shifted curve is stuck at vMax regardless of how much external accel helps.
2. **New `xInterceptShifted(curve, externalAccel)`.** Pure function: returns `vMax · (1 + externalAccel/accelAtZero)` clamped to `≥ 0`. Returns `+Infinity` if `vMax === Infinity` (the migration-from-scalar case).
3. **Mapper reads `ForceAccumulatorBuffer`.** It needs the external accel projected onto Ft and Rt to feed `xInterceptShifted`. Required reordering: `tangentInputMapperSystem` now `runsAfter` `forceFieldSystem` (and `characterOrientationSystem`, which runsBefore forceField, to avoid the cycle that `runsBefore characterOrientationSystem` introduced).
4. **Controller subtracts external from `aReq`.** `aReqF = (vDesF − vF)/dt − aExF`. The controller's voluntary thrust output is "what's needed AFTER external is already accounted for." At steady state v=vDes, aReqNet=0 → voluntary = −aEx → character coasts against the wind.
5. **Per-direction biomechanical ceilings, can go negative.** Replaced `clampMag(aReq, capF)` (a signed-magnitude clamp that assumes positive magnitude) with `clampToRange(value, lo, hi)` where `lo = −backMax`, `hi = +fwdMax`. Each *Max* is the curve evaluated in its direction, intersected with `gripBudget`. Past `vMax` in a direction the ceiling goes negative, naturally producing "even maximum forward effort produces deceleration" semantics.

## Code smells to track

1. Mapper now reads ForceAccumulator. That's fine — the accumulator IS the source of truth for external accel. But: the mapper does its own dot products of accumulator onto Ft/Rt, and the controller ALSO does the same dot products (for its `aExF`, `aExR`, `aExN`). Duplicate work, low-cost (1 player), but a candidate for putting tangent-frame projections of the accumulator into a buffer the controller reads. **Flag for later; not urgent.**
2. `profile.desiredRunSpeed` is now dead code in the mapper but still set on the default profile and used by `bodyLean` for animation. **Keep for now (animation reads it); revisit when we redesign profile shape.**
3. `clampToRange` handles `lo > hi` (inverted range) by averaging — defensive code. If lo>hi happens in practice it'd indicate overspeed in BOTH F and -F simultaneously, which is impossible for a 1D velocity. Could replace with `assertDev`. **Leave for now; harmless.**

## Verification

- 365 tests pass (5 new in `accelCurve.test.ts`). 2 pre-existing skipped. 0 fail.
- `npx tsc --noEmit` clean.
- Canary green.
- Smoke `?map=canyon-desert`: spawn at world `(0.00, 0.80, 64.51)`. No errors. (Same spawn point; equilibrium speed will differ from pre-B.2.5 on slopes.)

## Manual feel test the user needs to do

- `?map=canyon-desert`. Run uphill: should feel a bit slower than flat. Run downhill: should sustain a noticeably faster top speed than flat. (Pre-B.2.5 both were pinned to 8 m/s by the controller's brake.)
- Strafing while running forward should still feel snappy (per the B.1 lateral fix).
- Braking while running should still feel snappy.
- `?map=gym-cylinder-convex`: same baseline behavior; radial gravity makes "downhill" point toward the log axis, so running over the top should be slower than running down the side (toward the axis). Whether the cylinder centripetal-leave bug shows up will be tested in A after the user signs off feel.

## After B.2.5

- User feel-validates.
- We come back to A (cylinder bug diagnostic).
- Then B.3 (UV-space integration for surface-attached).
