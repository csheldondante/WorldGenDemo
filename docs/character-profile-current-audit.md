# `CharacterControllerProfile` — current-state audit (2026-05-19)

> **Status:** audit only. Describes what the profile contains *today*. Includes no proposals, no redesign, no opinion on what *should* be. The redesign discussion happens against this document; if anything below is wrong, that is the first thing to fix.

## Where it lives

| Concern | File |
| --- | --- |
| Type + default | `src/buffers/characterControllerProfile.ts` |
| Buffer wrapper | same file, `CharacterControllerProfileBufferData` (a `Map<ProfileId, CharacterControllerProfile>`) |
| Curve type | `src/lib/math/accelCurve.ts` (`LinearAccelCurve`) |
| Profile reference on a character | `src/buffers/characterController.ts`, field `profileId: ProfileId` on `CharacterControllerComponent` |

## Cardinal shape today

`CharacterControllerProfile` is a single flat-ish TypeScript interface. Top-level fields are mostly scalars with two nested sub-bags:

- `jump: { upSpeed, horizSpeed, horizBlendMax, holdMaxSec, stepCount, maxAngleBelowHorizonRad, minSurfaceScale }`
- `climb: { forwardAccel, backwardAccel, lateralAccel, upAccel, downAccel, engagementMaxSpeed }`

Everything else — slope thresholds, foot-planner timings, body-lean tuning, turning gains, wing-launch and glide knobs — sits at the top level as siblings of the run-state 6DoF curves. There is no other grouping.

Today's defaults are seeded as `DEFAULT_PLAYER_PROFILE` (one profile, id `"player"`). The buffer is a `Map<ProfileId, Profile>`, so additional profiles can be registered, but in practice only the player profile exists at runtime.

A single character carries a `profileId` (string) on its `CharacterControllerComponent`. Every consumer system fetches the profile via `profiles.byId.get(ctrl.profileId)`.

---

## Field-by-field consumer map

The table below groups every field of the current `CharacterControllerProfile` by the *category* I can read off from its consumer files. **Category** here is a description of what role the field plays for the consumer, not a proposed bucket — it just helps the reader compare like with like.

### Identity / physical constants

| Field | Type | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- | --- |
| `id` | `string` | `"player"` | `playerSpawn.ts`, `profileEditor*.ts`, scenario seeding | Identifier the character references via `ctrl.profileId`. |
| `name` | `string` | `"player"` | `profileEditorRender.ts` | Display string for the profile editor panel. Editable, decoupled from `id`. |
| `bodyRadius` | `number` | `0.5` | `surfaceConstrainedVelocity.ts`, `playerSpawn.ts` | Sphere radius — used as the surface offset (`pos = sample + R·N`) and the foot-position lookup. Also passed to spawn. |
| `desiredRunSpeed` | `number` | `8` | `bodyLean.ts` (`speedFactor = speed / desiredRunSpeed`) | Normalizes the speed factor used by the body-lean solver's `pelvisSpeedCompression` term. Doc comments on this field and on `tangentInputMapper.ts` claim input is "scaled by `desiredRunSpeed`" — that is **stale**; `tangentInputMapper.ts:136–143` actually scales by `xInterceptShifted(forwardAccel, aExF)`, not by `desiredRunSpeed`. The only live consumer is the body-lean normalization. |

### Surface-state 6DoF acceleration curves (run state)

Each entry is a `LinearAccelCurve = { accelAtZero, vMax }`. Both `vMax = Infinity` (treated as "no velocity cap; constant force") and finite `vMax` (force linearly decreases to zero at `vMax`) are used.

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `forwardAccel` | `{ 40, 8 }` | `characterController.ts`, `tangentInputMapper.ts` | Max forward self-applied accel curve; x-intercept (shifted by external along-tangent accel) IS the desired forward speed for input scaling. |
| `backwardAccel` | `{ 25, 6 }` | `characterController.ts`, `tangentInputMapper.ts` | Same role in the backward (−forward) direction. Sign-aware: backward consumes the backward curve while forward velocity persists. |
| `lateralAccel` | `{ 35, 8 }` | `characterController.ts`, `tangentInputMapper.ts` | Symmetric left/right strafe. Evaluated at `abs(vR)`. |
| `upAccel` | `{ 5, ∞ }` | `characterController.ts` | Grip budget along surface +normal. Conventionally `vMax = ∞` — this is a force budget, not a velocity-shaped thrust. |
| `downAccel` | `{ 0, ∞ }` | `characterController.ts`, `tangentInputMapper.ts` | Self-applied force into the surface (along −N). Two roles: (1) scales friction grip on the tangent plane (`tangentGrip = μ · (|gravity·N| + downAccel)`); (2) detach-resist budget consulted by the centripetal-aware leave-surface rule. Run sets this to `0` — legs do not press into the floor; gravity supplies all normal load. |

### Climb sub-bag (`climb`)

A nested object that *almost* mirrors the run-state 6DoF curves, plus one engagement threshold.

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `climb.forwardAccel` | `{ 30, 2 }` | `characterController.ts`, `tangentInputMapper.ts` (via `curves = profile.climb`) | Same role as `forwardAccel` but selected when `ctrl.state === "climb"`. High accel, very low vMax. |
| `climb.backwardAccel` | `{ 30, 2 }` | same | Same role for backward in climb. |
| `climb.lateralAccel` | `{ 30, 2 }` | same | Same role for lateral in climb. |
| `climb.upAccel` | `{ 20, ∞ }` | `characterController.ts` (curves selector) | Up-grip budget in climb. |
| `climb.downAccel` | `{ 20, ∞ }` | `characterController.ts`, `tangentInputMapper.ts` (via curves) | Press-into-surface force in climb. Cranked above gravity (`≈ 20`) so the body grips walls/overhangs where gravity's into-N component is ~0. |
| `climb.engagementMaxSpeed` | `1.5` | `characterController.ts:298, 309, 327, 336` | Tangent-speed threshold below which `surfaceRun` (or `surfaceSlide`) → `climb` on a slope steeper than `slopeRunMaxRad`. Also gates `climb` → `surfaceSlide` when exceeded by external impulse. |

### Surface-transition trigger scales

These are *multipliers* the surface-transition rules apply to surface-provided caps.

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `ragdollNormalInScale` | `1.5` | `characterController.ts:277, 279` | Multiplier on `surface.normalInMax`. Required normal-in > `scale × cap` → enter ragdoll. |
| `detachNormalOutScale` | `1.0` | **none — declared but never read** | Intended to multiply `surface.normalOutMax` for the detach-to-airborne threshold. No production consumer. |
| `slideGripScale` | `1.0` | **none — declared but never read** | Intended to multiply grip budget: required tangent force > `scale × budget` → slip into `surfaceSlide`. No production consumer. |

### Aerial-state scalars

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `airAccel` | `1.5` | `characterController.ts:741, 742` | Scalar magnitude of in-air thrust applied in the gravity-perpendicular plane. Deliberately small ("fine-tuning concession for joystick fidelity"). |
| `airSpeedCap` | `2` | `characterController.ts:720–722` | Horizontal speed cap on thrust-added air motion (not total horizontal velocity). |

### Jump impulse sub-bag (`jump`)

A nested object describing the press + hold model for the basic jump.

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `jump.upSpeed` | `7` | `characterController.ts:553–555` | Vertical component (m/s) of the "intended jump velocity" at full hold. |
| `jump.horizSpeed` | `4` | `characterController.ts:561` | Target horizontal speed at press when the stick is fully deflected. |
| `jump.horizBlendMax` | `0.5` | **none — declared but never read** | Documented as "how strongly joystick-targeted speed replaces current speed at press, in [0, 1]". No production consumer. |
| `jump.holdMaxSec` | `0.18` | `characterController.ts:663, 664, 674` | Window during which the impulse continues to be applied along its initial direction. |
| `jump.stepCount` | `4` | `characterController.ts:637, 664` | Discrete energy steps within the hold window (press-timing-snap). |
| `jump.maxAngleBelowHorizonRad` | `0.174` (~10°) | `characterController.ts:589, 601` | Max angle the press-time impulse can dip below world horizontal. |
| `jump.minSurfaceScale` | `0.2` | `characterController.ts:620` | Floor on the surface-orientation jump-force scale. Impulse magnitude scales by `max(minSurfaceScale, N · gravityUp)`. |

### Jump-variant fields at top level (not in `jump`)

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `wingLaunchHoldSec` | `0.35` | `characterController.ts` (jump-variant trigger) | Hold-time threshold to upgrade jump → wing-launch. |
| `wingLaunchImpulse` | `14` | `characterController.ts` (wing-launch application) | Vertical impulse magnitude (m/s) for the wing-launch jump variant. |

### Glide / flap fields at top level

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `flapImpulseUp` | `5` | `characterController.ts` (flap application) | Vertical impulse (m/s) of an airborne flap. |
| `flapImpulseFwd` | `3` | `characterController.ts` (flap application) | Forward impulse (m/s) of an airborne flap. |
| `glideGravityMul` | `0.25` | `forceField.ts:58` | Multiplier on world gravity while gliding. Smaller = floatier. |
| `glideForwardAccel` | `6` | `characterController.ts` (glide-state forward thrust) | Forward acceleration applied while gliding (m/s²). |

### Slope thresholds + airborne snap

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `slopeRunMaxRad` | `0.9` (~52°) | `characterController.ts:299` | Slope steepness above which `surfaceRun` → `surfaceSlide`. |
| `slopeStandMaxRad` | `0.7` (~40°) | `characterController.ts:314, 322` | Slope below which `surfaceSlide` → `surfaceRun` (hysteresis pair with `slopeRunMaxRad`). |
| `landingSnapMeters` | `0.4` | **none — declared but never read** | Documented as "snap to surface if within this height while airborne." `surfaceConstraint.ts:117` references the name in a comment describing an obsolete behavior, but no live read. |

### Turning scalars (yaw only)

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `desiredTurnRate` | `6` rad/s | `characterOrientation.ts:160` | Max body-turn rate; clamps the P-controller's output. |
| `turnAccelMax` | `40` rad/s² | `characterOrientation.ts:162` | Max body angular acceleration. |
| `turnPGain` | `8` rad/s per rad | `characterOrientation.ts:160` | P-gain on `(targetYaw − currentYaw)` → desired turn rate. Saturates to `desiredTurnRate` past a threshold. |

No pitch or roll equivalents exist today.

### Foot planner

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `footUnplantDistance` | `0.18` m | `footPlanner.ts:173` | Hip drift threshold from a planted foot before that foot begins a swing. |
| `footUnplantYawDelta` | `0.35` rad (~20°) | `footPlanner.ts:174` | Body yaw delta since plant before that foot starts a swing — enables turn-in-place. |
| `footSwingDuration` | `0.22` s | `footPlanner.ts:256, 257, 263` | Base swing duration; scaled by speed via `footSwingSpeedFactor`. |
| `footSwingSpeedFactor` | `0.10` | `footPlanner.ts:256` | Speed-induced reduction factor. Effective = `base / (1 + factor·speed)`. |
| `footMinSwingDuration` | `0.10` s | `footPlanner.ts:257` | Floor on the speed-scaled swing duration. |
| `footPlantLeadTime` | `0.04` s | `footPlanner.ts:263` | Extra lookahead beyond `footSwingDuration` when predicting plant target. |
| `footMaxReachStretch` | `0.85` | **none — see comment in `footPlanner.ts:180`** | Marked in its own field comment as "currently unused; reserved for a future 'tuck under' emergency path." |
| `footStepHeight` | `0.32` m | `footIk.ts:185` | Peak vertical lift during swing — scales the sine curve for swing arc. |
| `footStandingSpeed` | `0.15` m/s | **none — declared but never read** | Documented as the "balance plants under hip below this speed" threshold. No live consumer. |
| `footBrakeLeadGain` | `0.008` | `footPlanner.ts:262` | Extra lead (s per m/s² of decel) — plants land further forward of hip during braking. |
| `footBrakeLeadMax` | `0.05` s | `footPlanner.ts:262` | Hard cap on the brake-lead extension. |

### Airborne anim

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `airborneForwardPitch` | `0.28` rad (~16°) | `chainDynamics.ts:117` (parameter exists, **but the call site at `:96` always passes `0`**) | Documented as the forward-pitch bias for the spine chain target while airborne, scaled by horizontal-speed factor. Currently inert at runtime. |

### Body lean (apparent-gravity solver)

| Field | Default | Consumer(s) | What it controls |
| --- | --- | --- | --- |
| `leanDragCoeff` | `0.5` | `bodyLean.ts:139` | Implicit-drag coefficient (1/s). Effective accel = `a_real + dragCoeff · v`. Bigger = more steady-state forward lean at running speed. |
| `leanResponsiveness` | `8.0` | `bodyLean.ts:175` | Exponential smoothing rate for body-up chase (1/s). Time constant ≈ `1 / this`. |
| `maxLeanAngle` | `0.6` rad (~34°) | `bodyLean.ts:171` | Forward / lateral lean ceiling. |
| `maxBackwardLeanAngle` | `0.18` rad (~10°) | `bodyLean.ts:171` | Tighter ceiling on backward lean. |
| `steepSlopeWorldUpBias` | `0.9` | `bodyLean.ts:155` | 0..1 — as the support surface tilts away from world up, blend the body-up target toward world up by `steepness × this`. |
| `leanCompressionScale` | `1.0` | `bodyLean.ts:198` | Multiplier on the geometric hip-drop from lean. |
| `pelvisSpeedCompression` | `0.08` m | `bodyLean.ts:201` | Extra pelvis drop at full `desiredRunSpeed` added on top of `leanCompressionScale`. |
| `leanGravityCounterScale` | `1.0` | `bodyLean.ts:141` | 0..1 — how much of the static gravity-along-slope component the body leans into. Produces the "climber's lean." |

---

## Fields with no live consumer (dead code)

Verified by grep across `src/`. The following are declared in `CharacterControllerProfile`, seeded with a default value in `DEFAULT_PLAYER_PROFILE`, and have **zero** production reads:

1. `detachNormalOutScale`
2. `slideGripScale`
3. `jump.horizBlendMax`
4. `landingSnapMeters`
5. `footStandingSpeed`
6. `footMaxReachStretch` — comment in the field itself explicitly says "currently unused; reserved for a future 'tuck under' emergency path."

Plus one *effectively* dead field:

7. `airborneForwardPitch` — passed to `chainDynamics.ts` as a parameter, but `chainDynamics.ts:96` always supplies `0` at the call site. Runtime value is ignored.

Total: 7 fields out of ~50 are unused or inert.

## Doc / behavior mismatches noted

- The `desiredRunSpeed` doc comment and the `tangentInputMapper.ts` file header both claim input is scaled by `desiredRunSpeed`. The actual scaling is by `xInterceptShifted(forwardAccel, aExF)`. `desiredRunSpeed` is only consulted by `bodyLean.ts` for the speed-factor normalization.
- `airborneForwardPitch` — discussed above; runtime value ignored.

## Tests that depend on the current shape

A grep for `desiredRunSpeed`, `forwardAccel`, `bodyRadius`, `climb.`, `jump.`, `slopeRunMaxRad`, `desiredTurnRate`, and `foot*` field names in `tests/` returns hits in:

- `tests/systems/characterController.test.ts`
- `tests/systems/characterController.trajectory.test.ts`
- `tests/systems/characterController.centripetal.test.ts`
- `tests/systems/characterController.energy.test.ts`
- `tests/systems/footPlanner.test.ts`
- `tests/systems/bodyLean.test.ts`
- `tests/systems/inputMapper.test.ts`
- multiple `scenarios/*.ts` baselines (via `DEFAULT_PLAYER_PROFILE` import)

Any restructure will need to touch all of these files; the buffer-snapshot baselines under `scenarios/__baselines__/` will need re-recording with per-quantity classification per the project's MANDATORY change-discipline rule in the root `CLAUDE.md`.

## Editor-side observations (current profile-editor panel)

The editor in `src/systems/profileEditorRender.ts` renders the profile by walking the object generically:

- Top-level scalars + curves go into a `general` `<details>` section, open by default.
- The two nested sub-bags (`jump`, `climb`) each get their own `<details>` section.
- Each numeric field becomes a `<input type="number">` with a magnitude-aware step.
- `Infinity` values show as the literal `∞` and accept `Infinity`, `inf`, or `∞` as input.

This renders fine but reveals the shape directly: the `general` section is a long unstructured list because there is no further grouping in the source data.
