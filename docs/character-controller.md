# Character controller — end-to-end pipeline

> Status: this doc describes what's on `feature/scaffold-bitmap-to-3d` as of 2026-05-12. It complements [`docs/PHYSICS.md`](PHYSICS.md), which derives the surface-frame solver math and the *why*. This file is the *what* — the systems and buffers wired together each tick, and the data they pass.
>
> When you change anything in the controller stack, update this doc.

---

## 30-second tour

A character entity has these per-entity rows:

- `TransformBuffer` — position, yaw, scale
- `VelocityBuffer` — `linear[3]`, `prevLinear[3]` (world XYZ)
- `ForceAccumulatorBuffer` — `accel[3]` (cleared every tick by `VelocityIntegrationSystem`)
- `CharacterControllerBuffer` — FSM (`surfaceRun | surfaceSlide | airborne | wingLaunch | flap | glide`), `locomotionMode` (`surfaceConstrained | volumeConstrained`), `profileId`, `targetYaw`, `yawVel`, `bodyUpCurrent` quaternion, `orientation.{current,target}`, `lastTransitionReason`
- `SurfaceAttachmentBuffer` — `{ surfaceId, uv:[u,v], offsetAlongNormal, sample: SurfaceSample | null }`. Only populated when `locomotionMode === "surfaceConstrained"`
- `CharacterInputBuffer` — per-frame `{ moveX, moveY, jumpPressed/Held/Released/HoldSec, cameraYaw }`. Fanned out from semantic `InputMapBuffer`

There's exactly one `SurfaceProvider` per scene today, in `SurfaceProviderBuffer.heightmap` — a `HeightmapSurfaceProvider` wrapping the per-scene heightmap. The interface (`src/world/surfaceProvider.ts:36–53`) exists so analytic providers (plane/cylinder/torus) can plug in unchanged. Phase 1 adds them.

Every per-tick character work happens in the **Running graph** (`src/app/graphs.ts:68–93`).

---

## Per-tick frame sequence (Running graph)

The Running graph orders character systems as follows (`src/app/graphs.ts:71–90`). Only character-relevant nodes shown; render/minimap/hud/skeleton-debug omitted:

```
1. STATE_MACHINE_SYSTEM
2. INPUT_SYSTEM                  raw keyboard/mouse/gamepad → InputBuffer
3. INPUT_MAPPER_SYSTEM           bindings → InputMapBuffer (moveAxis, lookDelta, actions.jump)
4. CHARACTER_INPUT_SYSTEM        fan out moveAxis + cameraYaw → per-entity CharacterInputBuffer
5. CHARACTER_ORIENTATION_SYSTEM  body-yaw P-controller; writes Transform.yaw + ctrl.{yawVel, targetYaw}
6. FORCE_FIELD_SYSTEM            adds gravity (× glideGravityMul when state==glide) into ForceAccumulator
7. CHARACTER_CONTROLLER_SYSTEM   the FSM + surface-frame solver. Reads sample, accumulates tangent
                                 control + normal reaction, writes detach/smack/slide transitions.
                                 Airborne path writes velocity directly via approach().
8. VELOCITY_INTEGRATION_SYSTEM   semi-implicit Euler: v += a·dt; pos += v·dt; then clears accumulator
9. SURFACE_CONSTRAINT_SYSTEM     snaps surface-attached entities back to sample.y + bodyRadius;
                                 for volume-constrained, checks for landing within landingSnapMeters
10. CAMERA_FOLLOW_SYSTEM         camera tracks the player
11. CHARACTER_RENDER_SYNC_SYSTEM mirrors Transform → three.js Object3D
12. BODY_LEAN_SYSTEM             apparent-gravity solver → pelvis quaternion + hip-drop
13. CHAIN_DYNAMICS_SYSTEM        spine/tail secondary motion (driven by accel from prevLinear delta)
14. FOOT_PLANNER_SYSTEM          plant-and-step planner → FootLockBuffer
15. FOOT_IK_SYSTEM               2-bone IK per leg
16. SKELETON_WORLD_SYSTEM        baked bone world transforms for renderer
```

Steps 7–9 are the linear physics loop. Steps 12–15 are the animation pipeline; they read state but don't write back into the physics buffers.

---

## Buffers — who writes, who reads

| Buffer | Shape (key fields) | Written by | Read by |
|---|---|---|---|
| `CharacterControllerBuffer` (`src/buffers/characterController.ts:58`) | FSM state, locomotionMode, profileId, yawVel, targetYaw, bodyUpCurrent, orientation | `CharacterControllerSystem`, `SurfaceConstraintSystem`, `CharacterOrientationSystem`, `BodyLeanSystem` | All character systems |
| `SurfaceAttachmentBuffer` (`src/buffers/surfaceAttachment.ts:15`) | surfaceId, uv, sample | `SurfaceConstraintSystem` | `CharacterControllerSystem` (reads `sample` each tick) |
| `VelocityBuffer` (`src/buffers/velocity.ts`) | linear[3], prevLinear[3] | `CharacterControllerSystem` (airborne path, jump impulse), `VelocityIntegrationSystem`, `SurfaceConstraintSystem` (landing zeroes vy) | `BodyLeanSystem`, `FootPlannerSystem`, `ChainDynamicsSystem` |
| `ForceAccumulatorBuffer` (`src/buffers/forceAccumulator.ts`) | accel[3] | `ForceFieldSystem` (writes gravity), `CharacterControllerSystem` (adds tangent control + surface reaction), `VelocityIntegrationSystem` (clears at end) | `VelocityIntegrationSystem` |
| `CharacterControllerProfileBuffer` (`src/buffers/characterControllerProfile.ts:153`) | `byId: Map<ProfileId, Profile>` | seeded at boot with `DEFAULT_PLAYER_PROFILE` | `CharacterControllerSystem`, `BodyLeanSystem`, `FootPlannerSystem`, etc. |
| `SurfaceProviderBuffer` (`src/buffers/surfaceProvider.ts`) | `heightmap: SurfaceProvider \| null` | `pipeline/surfaceProviderSystem` during Rebuilding | `CharacterControllerSystem`, `SurfaceConstraintSystem` |
| `CharacterInputBuffer` (`src/buffers/characterInput.ts`) | per-entity moveX/Y, jump edges, cameraYaw | `CharacterInputSystem` | `CharacterControllerSystem` |

`writeBuffer` bumps `version`; the version-tracking is informational here (the scheduler enforces ordering via declared read/write hazards in `runsAfter`).

---

## The surface-frame solver

Math derivation lives in [`docs/PHYSICS.md`](PHYSICS.md). The implementation: `src/systems/characterController.ts:81–181`. Sketch:

```
# All vectors are world XYZ. The "tangent basis" is rebuilt every tick from the
# current SurfaceSample, so the controller never stores a tangent-space velocity.

# Inputs
sample  = surfaceAttachment.sample      # SurfaceSample {position, normal N, tangentU, tangentV, …}
v_world = velocity.linear
a_acc   = forceAccumulator.accel        # gravity (and any field forces) already in here
yaw_cam = input.cameraYaw

# Build a character-aligned basis from N and camera forward
Fw       = (−sin yaw_cam, 0, −cos yaw_cam)            # camera/character forward, XZ
Ft       = normalize(Fw − (Fw·N) N)                   # forward in tangent plane
Rt       = Ft × N                                     # right in tangent plane (unit)

# Project velocity into tangent basis
v_rel = v_world − surface.sampleVelocityAt(uv)        # moving-platform hook; zero today
vF = v_rel·Ft ; vR = v_rel·Rt ; vN = v_rel·N

# Desired tangent velocity from input
vDesF = input.moveY * profile.desiredRunSpeed
vDesR = input.moveX * profile.desiredRunSpeed
aReqF = (vDesF − vF) / dt
aReqR = (vDesR − vR) / dt

# Grip budget: μ × |normal component of existing forces|
aExN       = a_acc · N
gripBudget = sample.friction × |aExN|

# Sign-aware character cap then min with grip
charCapF = (aReqF ≥ 0 ? forwardAccelMax : backwardAccelMax)
charCapR = lateralAccelMax
aFEff    = clamp(aReqF, ±min(charCapF, gripBudget))
aREff    = clamp(aReqR, ±min(charCapR, gripBudget))

# Surface reaction: pin v_N to zero next tick
aSurfaceNRequired = −vN/dt − aExN
aSurfaceN         = clamp(aSurfaceNRequired, −normalOutMax, +normalInMax)

# State transitions (use uncapped requireds)
if aSurfaceNRequired >  normalInMax  × ragdollNormalInScale : LEAVE→airborne ("smack")
if aSurfaceNRequired < −normalOutMax × detachNormalOutScale : LEAVE→airborne ("detach")
if max(|aReqF|,|aReqR|) > gripBudget × slideGripScale      : surfaceRun→surfaceSlide
if sample.slopeRad >  slopeRunMaxRad                       : surfaceRun→surfaceSlide
if sample.slopeRad <  slopeStandMaxRad and |vF|+|vR|<0.5   : surfaceSlide→surfaceRun

# Add tangent control + surface reaction to the accumulator (additive)
a_acc += aFEff·Ft + aREff·Rt + aSurfaceN·N

# Jump: edge press → impulse, switch to airborne
if input.jumpPressed and surfaceConstrained:
  v.linear[1] = profile.jumpImpulse
  state = airborne ; locomotionMode = volumeConstrained
```

Notable details:

- **Velocity is stored XYZ** even when surface-constrained. The tangent basis is rebuilt every tick — there is no canonical tangent velocity living in a buffer.
- **`aExN` plays two roles**: friction budget input AND the existing-force term that the surface reaction has to oppose. The friction term takes its absolute value; the reaction term doesn't.
- **State transitions use uncapped (required) magnitudes**, not capped (effective). This is intentional — the surface needs to know "the controller wanted this much normal-out", not "the controller settled for this much".
- **Smack** (`aSurfaceNRequired > normalInMax × ragdollScale`) is "I'm being pushed into the surface harder than it can absorb". V1 has no ragdoll behavior, so the controller currently redirects to airborne. Phase C will land actual ragdoll behavior.
- **Detach** (`aSurfaceNRequired < −normalOutMax × detachScale`) is the only way to leave a curved surface today. Phase 4 of the active plan replaces this rule with one rooted in the **character's** profile (`downAccelMax`) plus a curvature-derived centripetal term — see *Known gaps* below.

### Airborne path (`characterController.ts:192–209`)

`v_world.xz = approach(v_world.xz, desired·airSpeedCap, airAccel, dt)`. Vertical comes from gravity in the accumulator. No surface decomposition, no friction, no IK plant — feet hang from the hip via FootIK's airborne case.

---

## Surface snap & landing (`src/systems/surfaceConstraint.ts`)

Runs after `VelocityIntegrationSystem`. Two cases:

**Surface-constrained** (`surfaceConstraint.ts:65–90`)
- `surface.worldToUV(t.position.xz)` → if outside [0,1]², flip to volume-constrained airborne with reason `"walked off edge"`
- Otherwise: `t.position ← sample.position + worldUp × bodyRadius`; refresh `attachment.sample`. This is the post-integration correction — the solver tries to keep `v·N` at zero, but FP drift accumulates, so we re-pin every tick.

**Volume-constrained** (`surfaceConstraint.ts:91–122`)
- Sample the surface under the character's XZ
- If descending (`v.y ≤ 0`) and `position.y ≤ groundY + landingSnapMeters`: snap to ground, zero `v.y`, transition to `surfaceRun` with reason `"landed"`
- Otherwise: leave alone, gravity will do its thing

**Note**: V1's vertical clearance uses `worldUp × bodyRadius`, not `surface.normal × bodyRadius`. On steep slopes the body clips a little. The PHYSICS.md doc calls this out as a known V1 simplification, to be fixed when body-up = −perceived-gravity orientation lands.

---

## The 6-DOF profile (`src/buffers/characterControllerProfile.ts`)

Every "feel" knob lives in `CharacterControllerProfile`. Defaults in `DEFAULT_PLAYER_PROFILE` (lines 159–208). Grouped by role:

| Group | Fields | What they gate |
|---|---|---|
| Tangent motion | `desiredRunSpeed`, `forwardAccelMax`, `backwardAccelMax`, `lateralAccelMax` | Top speed and acceleration in the tangent plane |
| Normal motion | `upAccelMax`, `downAccelMax` | Self-applied normal-direction push. Phase 4 will use `downAccelMax` as the leave-surface grip budget |
| State transitions | `ragdollNormalInScale`, `detachNormalOutScale`, `slideGripScale`, `slopeRunMaxRad`, `slopeStandMaxRad`, `landingSnapMeters` | Thresholds the FSM compares the per-tick computed `aSurfaceNRequired` / slope / slipMag against |
| Airborne | `airAccel`, `airSpeedCap`, `jumpImpulse`, `wingLaunchHoldSec`, `wingLaunchImpulse`, `flapImpulseUp/Fwd`, `glideGravityMul`, `glideForwardAccel`, `airborneForwardPitch` | Volume-mode movement, jumps, glide |
| Orientation | `desiredTurnRate`, `turnAccelMax`, `turnPGain` | Body-yaw second-order chase |
| Foot planner | `footUnplantDistance`, `footUnplantYawDelta`, `footSwingDuration`, `footSwingSpeedFactor`, `footMinSwingDuration`, `footPlantLeadTime`, `footMaxReachStretch`, `footStepHeight`, `footStandingSpeed`, `footBrakeLeadGain`, `footBrakeLeadMax` | Plant-and-step cadence, lookahead |
| Body lean | `leanDragCoeff`, `leanResponsiveness`, `maxLeanAngle`, `maxBackwardLeanAngle`, `steepSlopeWorldUpBias`, `leanCompressionScale`, `pelvisSpeedCompression`, `leanGravityCounterScale` | Apparent-gravity pelvis tilt + hip-drop |
| Body | `bodyRadius` | Vertical surface clearance |

Defaults: `desiredRunSpeed = 8 m/s`, `forwardAccelMax = 40 m/s²`, `downAccelMax = 5 m/s²` (much smaller than gravity — see *Known gaps*), `slopeRunMaxRad = 0.9 rad` (≈ 52°), `slopeStandMaxRad = 0.7 rad` (≈ 40°), `bodyRadius = 0.5 m`, `jumpImpulse = 7 m/s`.

---

## Orientation pipeline

**`CharacterOrientationSystem` (`src/systems/characterOrientation.ts`)** — second-order yaw chase. Picks a `targetYaw` each tick under two-tier rules: (1) if there's nonzero move stick, target = world direction of the stick; (2) else if look input is active, target = camera yaw; (3) else hold. Then computes desired turn rate via `turnPGain × (target − current)`, clamped to `desiredTurnRate`; integrates via `turnAccelMax` to update `yawVel` and `Transform.yaw`. Backward stick pivots the body 180° toward the camera — a feedback memory the user explicitly validated.

**`BodyLeanSystem` (`src/systems/bodyLean.ts`)** — apparent-gravity solver. Computes `apparentG = gravity − project(a_eff, N) + dragCoeff × velocity` and sets `bodyUp = −normalize(apparentG)`. On steep slopes, blends toward world-up by `steepSlopeWorldUpBias`. Slerps `ctrl.bodyUpCurrent` toward the target at `leanResponsiveness`. Writes the pelvis bone's local rotation and a geometric hip-drop (`L·(1 − cos θ)·leanCompressionScale + pelvisSpeedCompression·speedFactor`).

**`ChainDynamicsSystem`** — generic spine/tail chain (Wolfire-style velocity-driven spring lean). Each `RigSpec.chains` declaration becomes a damped axis-angle spring. Driven by the per-tick acceleration `(linear − prevLinear) / dt`, hence the `prevLinear` snapshot in `VelocityIntegrationSystem`.

**`FootPlannerSystem` (`src/systems/footPlanner.ts`)** — plant-and-step. Each foot stays at a planted world position until hip-drift exceeds `footUnplantDistance` OR body yaw drifts by `footUnplantYawDelta`. On unplant, the foot swings one-at-a-time toward a target = `surface(hip + velocity × (swingDuration + footPlantLeadTime))`. Brake-lead extends the lookahead during deceleration. Writes `FootLockBuffer`.

**`FootIKSystem` (`src/systems/footIk.ts`)** — two-bone analytic IK per leg, generic over `RigSpec.legs[]`. Surface-constrained: target = the plant from `FootLockBuffer` plus the swing-arc lift. Volume-constrained: feet tuck under hip (drop 0.55 m, forward 0.10 m). Same code handles bipeds and quadrupeds — quadrupeds just declare four `LegSpec` entries.

---

## How an entity becomes surface-constrained

At rebuild time, `PlayerSpawnSystem` (`src/systems/pipeline/playerSpawn.ts`) registers a player entity in `CharacterControllerBuffer`, `SurfaceAttachmentBuffer`, `VelocityBuffer`, `TransformBuffer`. Initial attachment is at the heightmap center with `locomotionMode = surfaceConstrained`, `state = surfaceRun`. The first `SurfaceConstraintSystem` tick fills in `sample`.

Once running, the entity transitions between modes via the rules above:

- **Surface → Airborne**: smack, detach, jump, walked off edge
- **Airborne → Surface**: descending into surface within `landingSnapMeters` (re-attaches at the XY-projected sample)
- **SurfaceRun ↔ SurfaceSlide**: slope threshold or grip threshold

---

## Current leave-surface conditions (the four ways out today)

All four live in code:

1. **Smack** — `aSurfaceNRequired > sample.normalInMax × profile.ragdollNormalInScale` (`characterController.ts:154`). Currently routes to airborne with `lastTransitionReason = "smack: ..."`.
2. **Detach** — `aSurfaceNRequired < −sample.normalOutMax × profile.detachNormalOutScale` (`characterController.ts:159`). This is the *only* way to leave a surface from speed-on-curvature today. The budget is **per-surface** (`normalOutMax`), not per-character. Default `normalOutMax = 200 m/s²`, which is large enough that detach rarely fires on the existing heightmap.
3. **Jump** — `input.jumpPressed && surfaceConstrained` (`characterController.ts:187`). Writes `v.y = jumpImpulse` directly.
4. **Walked off edge** — `surface.worldToUV` clamps and the clamped UV ≠ raw UV (`surfaceConstraint.ts:71`). Triggers when the player crosses the heightmap boundary.

Slide (`surfaceRun → surfaceSlide`) is *not* a leave — the character is still surface-constrained, just with reduced steering and gravity-along-slope dragging them downhill.

---

## Known gaps (motivation for the active plan)

1. **No `getCurvature` on `SurfaceProvider`.** The interface (`src/world/surfaceProvider.ts:36–53`) has `sampleAtUV`, `worldToUV`, `uvToWorld`, `canAttachAt`, `sampleVelocityAt` but no directional curvature query. Without it, the controller can't compute the centripetal demand required to follow a curved surface, and the only detach path is the per-surface `normalOutMax` heuristic.

2. **Detach budget is per-surface, not per-character.** The user wants leave-surface to fire when the character's own `downAccelMax` can't hold against the apparent (external + signed centripetal) force in the +N direction. Phase 4 of the active plan swaps the budget.

3. **Single `heightmap` slot.** `SurfaceProviderBuffer` has one slot; the only provider implementation is `HeightmapSurfaceProvider`. Phase 2 of the plan renames the slot to `active` and adds `Plane/Cylindrical/Torus` providers; Phase 5 (deferred) generalizes to a map of providers for surface transitions (wall-running).

4. **No analytic provider for tests.** All physics tests today either drive synthetic `SurfaceSample` objects or use a real heightmap. With analytic providers we'll be able to assert exact curvature and exact slope behavior end-to-end through the controller.

5. **Body sphere clips slightly on slopes** because vertical clearance is `worldUp × bodyRadius`, not `surface.normal × bodyRadius`. Tracked separately in PHYSICS.md; out of scope for the active plan.

6. **Airborne path bypasses the accumulator.** `characterController.ts:207–208` calls `approach()` and writes velocity directly. PHYSICS.md flags this as legacy; unify when flying lands.

---

## Reference points

- Solver: `src/systems/characterController.ts:55–220`
- Surface snap & landing: `src/systems/surfaceConstraint.ts:43–129`
- Integration: `src/systems/velocityIntegration.ts:15–66`
- Gravity: `src/systems/forceField.ts:28–59`
- Input fan-out: `src/systems/characterInput.ts:25–63`
- Body yaw: `src/systems/characterOrientation.ts`
- Body lean: `src/systems/bodyLean.ts`
- Foot planner / IK: `src/systems/footPlanner.ts`, `src/systems/footIk.ts`
- FSM states: `src/buffers/characterController.ts:6–14`
- Profile: `src/buffers/characterControllerProfile.ts:11–151`
- Running graph order: `src/app/graphs.ts:67–93`
- Tests: `tests/systems/characterController.test.ts`, `tests/world/surfaceProvider.test.ts`, `tests/systems/bodyLean.test.ts`, `tests/systems/characterOrientation.test.ts`, `tests/systems/footPlanner.test.ts`
- Active plan: `C:\Users\cshel\.claude\plans\ok-i-want-to-goofy-locket.md`
