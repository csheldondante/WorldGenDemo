# Physics — surface-frame solver

> Status: shipped May 2026 (commits `9808822..2c5397c`). Replaces the V0.1 "snap velocity-XZ + clamp Y to surface" hack.

## The model in one paragraph

Velocity is always 3D world-space. Inputs map to a *desired velocity* in the surface tangent plane (character-relative). The controller pushes toward it with up to `min(directional profile cap, friction × |normal force|)` of tangent acceleration, and the surface adds a normal-direction reaction that pins `v_N` to zero (or breaks attachment when stiffness is exceeded). Gravity is just another force in the accumulator — surface absorbs the normal component, gravity-tangent stays in. Jumps are direct velocity impulses outside the loop.

## Why not the obvious hack

The naive approach — set `v.y = 0`, integrate desired velocity in horizontal XZ, then snap `position.y` to the surface height — has three problems:

1. **Speed compounds with slope.** Horizontal movement happens at runSpeed *plus* a free vertical teleport, so going up a 45° slope is `√2 × runSpeed`.
2. **No friction physics.** Sand vs rock vs ice play the same. Sliding behavior has to be hardcoded as state branches.
3. **Doesn't generalize.** Walls, ceilings, spheres, moving platforms each need their own bespoke code.

The surface-frame solver fixes all three with one model.

## The pieces

### Surface profile (`src/world/surfaceProvider.ts`)

```ts
interface SurfaceSample {
  position, normal, tangentU, tangentV, slopeRad, traversable;  // existing
  friction:    number;  // kinetic μ (rock 1.0, sand 0.6, ice 0.2)
  normalInMax: number;  // m/s² absorbable into surface before ragdoll
  normalOutMax: number; // m/s² holdable against before detach
}

interface SurfaceProvider {
  sampleAtUV, worldToUV, uvToWorld, canAttachAt;        // existing
  sampleVelocityAt(u, v): [number, number, number];     // moving-platform hook (V1: returns [0,0,0])
}
```

A surface provider is the *physics-shape* of a region. V1 ships only `HeightmapSurfaceProvider`; future providers (walls, spheres, vehicle decks, climbable rocks) plug in unchanged because the controller reads only the sample fields.

### Character profile (`src/buffers/characterControllerProfile.ts`)

Directional acceleration limits — the maximum *self-applied* force per character-relative axis:

```ts
desiredRunSpeed: number;        // target tangent-plane speed
forwardAccelMax, backwardAccelMax: number;
lateralAccelMax: number;
upAccelMax, downAccelMax: number;
ragdollNormalInScale, detachNormalOutScale, slideGripScale: number;
```

These get further capped by surface grip = `friction × |normal force|`.

### Per-tick math (`src/systems/characterController.ts`, surface branch)

```pseudo
N    = sample.normal
F_w  = world forward from camera/character yaw (XZ only)
F_t  = normalize(F_w − (F_w·N) N)        # forward in tangent plane
R_t  = F_t × N                            # right in tangent plane

v_rel = v_world − surface.sampleVelocityAt(uv)  # zero for static surfaces
v_F = v_rel·F_t  ;  v_R = v_rel·R_t  ;  v_N = v_rel·N

# Input → desired tangent velocity (analog magnitude scales)
v_des_F = input.moveY * desiredRunSpeed
v_des_R = input.moveX * desiredRunSpeed

# Required acceleration to reach desired
a_req_F = (v_des_F − v_F) / dt
a_req_R = (v_des_R − v_R) / dt

# Friction grip = μ × |normal force from existing forces|
a_existing_N = (accumulator) · N
gripBudget = friction × |a_existing_N|

# Sign-aware character cap, then min with grip
a_F_eff = clamp(a_req_F, ±min(directional_char_cap, gripBudget))
a_R_eff = clamp(a_req_R, ±min(lateralAccelMax,      gripBudget))

# Surface adds normal reaction to pin v_N to 0
a_N_required = -v_N/dt − a_existing_N
a_N_eff      = clamp(a_N_required, -normalOutMax, +normalInMax)

# State transitions BEFORE writing accel (use REQUIRED, un-capped, magnitudes)
if a_N_required > normalInMax × ragdollScale:    ragdoll  (smack — V1 redirects to airborne)
if a_N_required < -normalOutMax × detachScale:   airborne (detach — ridge launch)
if max(|a_req_F|, |a_req_R|) > grip × slideScale: surfaceSlide (grip exceeded)
if slope > slopeRunMax:                          surfaceSlide (gravity wins)

# Add control + surface reaction to accumulator (additive)
accumulator += a_F_eff·F_t + a_R_eff·R_t + a_N_eff·N
```

`VelocityIntegrationSystem` then runs `v += a·dt; p += v·dt` unchanged. `SurfaceConstraintSystem` snaps `position.y` back to the surface as drift correction.

### Gravity

Lives in `ForceFieldSystem`, applied to **every** character entity (not just airborne). Treating gravity as just another force in the accumulator is what lets the surface absorb the normal component cleanly and lets future weird-gravity zones compose without new code.

### Jumps and impulses

Direct velocity writes on edge events: `v.linear[1] = profile.jumpImpulse`. The desired-velocity loop runs every tick; impulses fire once. Same channel for flaps, knockbacks, dash bursts.

## Sharp edges

1. **Active control = active braking.** Going downhill on rock with high grip: controller brakes excess speed → steady-state at runSpeed in tangent plane. Going downhill on ice (low μ): controller can't brake → you slide and accelerate with gravity. The "downhill is faster" feel is a *consequence of low grip*, not a free speed bonus. Tune friction per surface to deliver feel; don't add a downhill multiplier.

2. **Curved surfaces at speed produce real centripetal demands.** `v²/r` along the inward normal. Exceeds `normalInMax × scale` → fly off. This is desired (ridge launches), but be aware that surface-stick is a constraint, not a guarantee.

3. **Orientation must stay separate from linear physics.** Body orientation = quaternion target updated by FSM state, slerped each tick. RenderSync reads `current`. The linear solver never reads it (input mapping uses character/camera *yaw*, not body roll). Decoupling means tumble can spin freely without affecting position integration.

4. **Airborne is still legacy.** The airborne / wingLaunch / flap / glide branch writes velocity directly via `approach()`. Unify when implementing flying (see below) so that path also flows through accumulator → integrate.

## Extension hooks (reserved, not yet implemented)

- **`SurfaceProvider.sampleVelocityAt(uv)`** — return non-zero for moving platforms; controller already subtracts.
- **`CharacterControllerComponent.orientation: { current, target }`** — quaternions on `byEntity` map. Phase C wires an OrientationSystem that slerps `current → target` each tick; FSM transitions update `target`.
- **`ragdoll` ControllerState** — solver triggers entry on excess normal-in. Behavior (free rotation + restitution + recovery) is Phase 2C.
- **Per-terrain friction** — `HeightmapSurfaceProvider` currently returns `friction: 1` for all terrain. Extend to per-terrain-id (rock 1.0 / sand 0.6 / ice 0.2) when tuning feels right.

## Flying (the dragon controller) — same pipeline, different mappings

The flying state isn't a separate physics regime — it's the same desired-velocity → acceleration → integrate pipeline with two changes:

1. **Initial phase** (input → desired): no surface tangent plane, so desired direction is in *body frame* (or world XYZ), not projected. Dragon orientation FSM picks the body frame.
2. **Final phase** (desired → what happens): no surface to absorb normal force. Gravity acts always. Lift comes from impulses (flap) or a glide multiplier on gravity. Drag is a passive force opposing velocity (capped by some "wing drag coefficient" scalar in the profile).

**Dragon high-level controller** — sits *above* the low-level physics, just emits impulses + sets flags:

| Input | Effect | Where |
|---|---|---|
| Tap jump | Small flap impulse, immediate response | direct `v += impulse * up`; impulse magnitude small + directionality favors up-and-forward in body frame |
| Hold-then-release jump | Larger flap impulse, magnitude proportional to hold time | accumulate `flapCharge` over hold, fire on release as a single dV |
| Hold continuously (no release) | Glide mode — reduced gravity multiplier + small forward thrust converting PE→KE | flag in controller; `ForceField` reads it as `glideGravityMul`; controller adds forward thrust |
| Rapid flap (multiple taps) | Multiple impulses → decelerate before landing | natural consequence of impulse channel; tune impulse direction to oppose -v |
| Smack into ground at high speed | Ragdoll | already wired: required normal-in > stiffness × scale → ragdoll state |

PE → KE during glide is automatic: gravity is in the accumulator, doing positive work on velocity going down. With reduced glide-gravity multiplier, the dragon falls slower but still gains speed; with no glide, it falls faster and gains speed faster. Players will feel the trade.

Flap directionality in body frame: probably "up + forward" relative to the dragon's body orientation, where body forward might tilt down for a dive. The orientation FSM controls body roll/pitch independent of input. Linear physics doesn't care; the impulse direction is computed from the orientation quaternion at fire time.

## Reference points

- Solver: `src/systems/characterController.ts`
- Profile: `src/buffers/characterControllerProfile.ts`
- Surface model: `src/world/surfaceProvider.ts`, `src/buffers/surfaceAttachment.ts`
- Force model: `src/buffers/forceAccumulator.ts`, `src/systems/forceField.ts`, `src/systems/velocityIntegration.ts`, `src/systems/surfaceConstraint.ts`
- Tests: `tests/systems/characterController.test.ts` — flat / slope / brake / icySlide / detach / ragdoll / jump
- Long-term-memory wiki article: `wiki/surface-frame-physics-solver.md` (cross-project pattern)
