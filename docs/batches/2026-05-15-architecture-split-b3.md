# Batch: Architecture split — Phase B.3 (UV-space integration for surface-attached)

Date: 2026-05-15. Continues from `2026-05-15-mesa-and-landing-fix.md`.

## Goal — eliminate XYZ-then-snap

Replace the per-tick "integrate world position in XYZ, then snap back onto the surface" pattern with UV-space integration: the character's position lives in UV coordinates while attached, and world position is DERIVED from UV each tick. The body is geometrically on the surface by construction, no snap step.

Per the surface-frame-physics-solver wiki article.

## What changed

- **`SurfaceConstrainedVelocitySystem` does UV integration.** Each tick:
  1. Project world velocity onto sample tangents → UV-parameter velocity.
  2. Project accumulator accel onto the same tangents → UV-parameter acceleration.
  3. Semi-implicit Euler in UV: `uvel += auv·dt; uv += uvel·dt`.
  4. Sample surface at new UV → new world position = `sample + radius·N`.
  5. World velocity reconstructed from UV velocity × new tangent magnitudes × new tangents.
  Normal component of accel/velocity is implicitly zero (the constraint is exact). New attachment is cached.
- **`SurfaceConstraintSystem` no longer snaps surface-attached entities.** Its job is purely event handling now: detect out-of-bounds UV → "walked off edge" → airborne. Landing detection for volumeConstrained entities unchanged.
- **No silent fallback** when SurfaceProviderBuffer is empty. `assertDev` fires if any surface-attached entity exists without a provider — per `wiki/worldgen-demo-no-silent-fallbacks-in-tests.md`.

## Tests updated to use real providers

`tests/systems/characterController.test.ts:setup()` previously synthesized a `SurfaceSample` on the attachment and skipped registering a `SurfaceProvider`. That worked under XYZ-then-snap but masks every bug B.3 exists to fix. Replaced with a real `PlaneSurfaceProvider` parameterized by `slopeRad`, `friction`, `normalInMax`, `normalOutMax`. The provider is registered in `SurfaceProviderBuffer`; the attachment's sample comes from `provider.sampleAtUV(0.5, 0.5)`; character spawn position is `sample + radius·N`.

Tests now exercise the actual UV integration pipeline.

## Decisions

1. **Body offset along normal (not Y-up).** When deriving world position from UV: `position = sample.position + radius·sample.normal`. For heightmaps where N ≈ +Y this is essentially the prior Y-offset; for curved surfaces (cylinders, future spheres) it correctly places the body inside-the-tube / on-top-of-the-log. The previous bug where this broke uphill walking was specific to XYZ-snap (every tick the snap shifted XZ by N's lateral components); UV integration doesn't have that bug because position is derived from UV directly, not corrected from the prior tick.
2. **`uv` stored un-clamped** so `surfaceConstraintSystem` can detect walked-off-edge from `uv ∉ [0, 1]`. The sample call uses the clamped UV (providers don't have to handle out-of-range).
3. **No B.2-era XYZ fallback in the integrator.** User's directive: "Don't add fallbacks. Fail loudly and fix it." If a surface-attached entity exists but no provider is registered, `assertDev` throws.

## Code smells to track / review at end of batch

(none new in this batch — the B.2 smells "duplicate integration code in both systems" remains, but B.3 removes the duplication since the surface variant now does UV integration uniquely. The volumetric still does XYZ Euler.)

## Result

- 365 tests pass; 2 pre-existing skipped; 0 fail.
- `npx tsc --noEmit` clean.
- Canary green.
- Smoke canyon-desert: clean boot, spawn unchanged.
- Smoke gym-mesa: clean boot, spawn at `(-6.00, 5.50, 0.00) uv (0.4, 0.5)` — sample + radius·N for the flat-top mesa.

## Manual feel test the user needs to do

- `?map=canyon-desert`: walking, running, jumping, falling off cliffs. UV integration shouldn't change the feel on heightmaps; if it does, that's a bug to surface.
- `?map=gym-mesa`: slow → walks down lip. Sprint → flies off lip with airborne arc. Should match pre-B.3 mesa behavior (the strict-landing fix from the previous batch is preserved).
- `?map=gym-cylinder-convex`: running around the log. With UV integration the body should track the cylinder's curvature WITHOUT the XZ teleport-to-side bug that the worldToUV fix only partially addressed.
- `?map=gym-cylinder-concave`: wall of death. Body should stick to the inside wall via radial gravity + UV integration (no snap to fight the radial direction).

## After B.3

- B.4: body orientation reads surface normal (fixes "character not oriented to surface" on cylinder gyms).
- Cylindrical / spherical heightmaps (richer centripetal-test gyms).
- Surface transitions (wall-run, then climbing). Phase 5.
