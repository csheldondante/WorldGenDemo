# Batch: Architecture split — Phase B.2 (Surface vs Volumetric velocity integration)

Date: 2026-05-15. Continues from `2026-05-15-architecture-split-b1.md`.

## Goal of B.2 — pure refactor, no behavior change

Replace the combined `VelocityIntegrationSystem` with two systems:

- `SurfaceConstrainedVelocitySystem` — integrates entities where `characterController.byEntity[id].locomotionMode === "surfaceConstrained"`.
- `VolumetricConstrainedVelocitySystem` — integrates everything else (airborne characters AND any moving non-character entity).

Both still do the same XYZ semi-implicit Euler the old combined system did. B.3 will change the math inside `SurfaceConstrainedVelocitySystem` to UV-space integration.

After B.2:
- `SurfaceConstraintSystem` declares `runsAfter` on both new systems.
- `velocityIntegration.ts` is deleted.
- Tests in `tests/systems/characterController*.ts` use the new pair.

## Decisions

1. **Volumetric system iterates `VelocityBuffer.byEntity`, not `CharacterControllerBuffer.byEntity`.** The previous combined system iterated velocities so any moving entity got integrated. Splitting strictly by character roster would lose non-character entities (future projectiles, vehicles, etc.). The volumetric system filters with `ctrl?.locomotionMode === "surfaceConstrained"` to *exclude* surface-attached, so anything else (including no-CC entities) flows through it.
2. **Surface system runs first.** Arbitrary but deterministic. Doesn't affect output because the two systems touch disjoint entity sets, but the hazard checker needs an ordering on the shared buffers.
3. **Each system clears its own accumulator slot.** Avoids double-clearing or skipping. Per-entity clears, not a buffer-wide clear like the old code.

## Code smells to track / review at end of batch

1. Both systems duplicate the integration code (pre-snapshot velocity, integrate accel, advance position, clear accumulator). B.3 changes only the surface variant; the volumetric one stays. After B.3 the duplication is gone-ish but the per-entity loops still mirror each other. Acceptable.
2. The volumetric system imports `CharacterControllerBufferData` only to read `locomotionMode`. If non-character entities get a different way to opt in/out of surface integration (e.g., per-entity tags), the dependency on CC could be revisited. Low priority.

## Result

- 360/360 tests pass; 2 pre-existing skipped; 0 fail.
- `npx tsc --noEmit` clean.
- Canary `coreGraphs.test.ts` green.
- Smoke canyon-desert: spawn at `world (0.00, 0.80, 64.51)` — byte-identical to pre-B.2. No errors.
- Registry: 24 buffers, 34 systems (`velocityIntegrationSystem` gone, two new ones added).

## Next: B.3

Change `SurfaceConstrainedVelocitySystem` to integrate position in UV space:
- Read current UV from `SurfaceAttachmentBuffer`, project world accel into UV via tangent vectors and `tangentUNorm`/`tangentVNorm`.
- Integrate `uv += uvVel·dt + 0.5·uvAccel·dt²`.
- Map back to world via `surface.uvToWorld(uv_new)` and tangent vectors for velocity reconstruction.
- Remove the snap from `SurfaceConstraintSystem`. The system becomes the attach/detach event handler only.
- This is the BEHAVIOR CHANGE step. Validate via gym feel before automation.
