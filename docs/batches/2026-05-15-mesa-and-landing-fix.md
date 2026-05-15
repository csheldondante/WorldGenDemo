# Batch: gym-mesa scene + strict landing-snap fix

Date: 2026-05-15. Follows B.2.5.

## Goal — make centripetal-detach actually feel like flying off a lip

User-reported: "I still don't detach from flat ground when running down a very steep hill even at high velocity." Investigation showed centripetal detach was firing correctly, but `surfaceConstraintSystem`'s landing rule with a `+landingSnapMeters` (0.4m) grace window above groundY was immediately re-attaching the body — because on a smooth half-cosine lip, surface drops only a few cm in the first tick after detach, putting the body well within the 0.4m grace.

## Decisions

1. **`gym-mesa` parametric variant.** Half-cosine descent from a flat circular top to ground, on a synthetic heightmap. C¹-continuous slope (tangent matches at top and bottom of the lip), high second derivative concentrated AT the lip — exactly the geometry that should trigger centripetal-leave on a fast traverse. Parameters: `peak`, `topRadius`, `slopeWidth` in the scene.json.
2. **Strict landing rule.** Changed `surfaceConstraint.ts:113` from `t.position[1] <= groundY + landingSnapMeters` to `t.position[1] <= groundY`. See `wiki/worldgen-demo-landing-snap-strict.md` for full rationale. Real falls still snap (body crosses groundY on the way down). Brief detach events stay airborne until gravity drops them onto the next surface.

## Code smells to track / review at end of batch

1. `landingSnapMeters` knob on the profile is now unused. Keep for now (might want to add a velocity-scaled grace later if jitter shows up on flat terrain), but it's documentation-debt. Low priority.
2. `surfaceConstraintSystem` still does XYZ-snap-then-pin-y on the attached branch. With B.3's UV integration, this whole system collapses to "attach/detach event handler" only. Not a smell from THIS batch; just a reminder that the larger refactor is pending.

## Result

- 365 tests pass; 2 pre-existing skipped; 0 fail.
- `npx tsc --noEmit` clean.
- Canary green.
- Manual feel-test by user on `gym-mesa`: slow walk → descends slope normally; sprint → detaches at the lip, arcs through the air, lands on the flat bottom. **User-validated 2026-05-15.**
- Same fix should also resolve the canyon-desert "running fast off a cliff doesn't go airborne" complaint, because the same `+0.4m` grace was masking real detaches there too.

## What's still on the punch list (not in this batch)

- B.3: UV-space integration for surface-attached entities. Replaces XYZ-then-snap with integrate-in-UV. Eliminates the entire class of snap-vs-velocity bugs.
- B.4: body orientation reads surface normal. Fixes "character not oriented to surface" on cylinder gyms.
- Cylindrical / spherical heightmaps (user's "better centripetal tests" suggestion).
- Parametric faces (cut faces — half-pipes, ramps, luge tracks).
- Phase 5: surface transitions (wall-run, climbing).
