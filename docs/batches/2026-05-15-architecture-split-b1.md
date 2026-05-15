# Batch: Architecture split — Phase B.1 (TangentInputMapper)

Date: 2026-05-15
Per the user-directed architecture rewrite (see `wiki/worldgen-demo-parametric-faces-vision.md` and the conversation on 2026-05-15). This batch is the first of four (B.1 → B.4) that decompose `CharacterControllerSystem` toward the proposed clean architecture: `RawInput → RawInputMapper → TangentInputMapper → ... → CharacterController → SurfaceConstrainedVelocity / VolumetricConstrainedVelocity`.

## Goal of B.1 — pure refactor, no behavior change

Extract the **tangent-frame projection** (currently inlined in `CharacterControllerSystem` lines 87–103 and 117–119) into its own system, `TangentInputMapperSystem`, that writes to a new per-entity `CharacterTangentInputBuffer`.

After B.1:
- `CharacterControllerSystem` no longer computes `Fw`, `Ft`, `Rt`, `vDesF`, `vDesR`. It reads them.
- `TangentInputMapperSystem` owns the projection.
- All existing tests pass (the system math is unchanged; we just moved it across a buffer boundary).

## Decisions

1. **New buffer (`CharacterTangentInputBuffer`), not extending `CharacterInputBuffer`.** User-confirmed. `CharacterInputBuffer` stays "what came from the player" (device-agnostic semantic input + camera yaw). The new buffer is "the surface-tangent projection of that input" — produced by a different upstream and consumed by a different downstream.
2. **The buffer carries the full tangent frame, not just `vDesF/vDesR`.** Today the controller uses `Ft`, `Rt`, `N` for *both* the input projection (`vDesF · Ft + vDesR · Rt`) and the world-to-tangent velocity projection (`vF = vRel · Ft`, etc.). To avoid duplicating that math in the controller, the mapper writes the unit basis `Ft`, `Rt` plus `vDesF`, `vDesR`. The controller reads these and computes `vF`, `vR`, `vN` itself (it's the only system that does the velocity projection step).
3. **Mapper only writes for `surfaceConstrained` entities.** Airborne entities don't have a surface-tangent frame and the controller's airborne branch doesn't read this buffer. Stale entries are tolerated (not zeroed) because they're harmless. If anyone consumes the buffer outside the surface branch, that's a programming error and should `assertDev`.
4. **`desiredRunSpeed` knob.** Currently `vDesF = moveY · profile.desiredRunSpeed`. After Phase 2a, `desiredRunSpeed` is conventionally equal to `forwardAccel.vMax`. The mapper reads `profile.desiredRunSpeed` to preserve byte-identical output during B.1. Future cleanup (B.3+ or later) can collapse it.
5. **Ordering**: mapper `runsAfter` `CharacterInputSystem`. Controller `runsAfter` `TangentInputMapperSystem`.

## Code smells to track / review at end of batch

1. `profile.desiredRunSpeed` is duplicated information after Phase 2a — by convention `= profile.forwardAccel.vMax`. The tangent mapper currently reads `profile.desiredRunSpeed` to preserve byte-identical behavior across B.1. To fix this we'd want one source of truth (either keep `desiredRunSpeed` and derive the curve's `vMax` from it, or drop `desiredRunSpeed` and read `forwardAccel.vMax` everywhere). **Status: deferred — flag for end-of-batch review when we redesign the profile shape (B.3 or per-state profiles work).**
2. Lateral desired velocity uses `profile.desiredRunSpeed` as the scaling factor even though there's a separate `lateralAccel.vMax`. The lateral max speed conceptually should be `lateralAccel.vMax`, not `forwardAccel.vMax`. **Status: pre-existing, NOT introduced by B.1. Flag for the same redesign.**
3. The mapper writes `byEntity.set(...)` but never deletes stale entries when a character transitions from surfaceConstrained → volumeConstrained. The controller's airborne branch doesn't read them, so this is harmless today, but if any future consumer reads without checking locomotionMode, they'd see stale tangent frames. **Status: low priority; would clean up when adding a separate VolumetricInputMapper if one is needed, or by deleting the entry on locomotion-mode transition.**

## Result

- All 360 tests pass; 2 pre-existing skipped; 0 fail.
- `npx tsc --noEmit` clean.
- `tests/migration/coreGraphs.test.ts` canary green (new buffer + system declared + ordered honestly).
- Smoke canyon-desert: spawn at `world (0.00, 0.80, 64.51)` — byte-identical to pre-B.1 spawn. No errors.
- 24 buffers, 33 systems in registry doc.

## Verification

- `npx tsc --noEmit` clean.
- `npx vitest run` — all green (no behavior change; same math, same buffers in/out).
- `tests/migration/coreGraphs.test.ts` — canary still passes (new system + buffer registered honestly).
- Manual: `npm run dev` → canyon-desert. Run uphill, run downhill, brake, jump. Feels identical to pre-B.1.

## Plan after B.1

- **B.2**: split `VelocityIntegrationSystem` into `SurfaceConstrainedVelocitySystem` (still XYZ-integrate-then-snap for B.2) + `VolumetricConstrainedVelocitySystem`. Pure refactor.
- **B.3**: switch `SurfaceConstrainedVelocitySystem` to UV-space integration. **Behavior change.** Fixes the cylinder-walking and cliff-snap bug classes.
- **B.4**: body orientation reads surface normal / per-position apparent gravity. Fixes the "character not oriented to surface" cylinder-gym bug.
