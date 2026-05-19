import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../../src/buffers/characterController";
import { CHARACTER_INPUT_BUFFER_ID, type CharacterInputBufferData, emptyInput } from "../../src/buffers/characterInput";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../../src/buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../../src/buffers/velocity";
import { SURFACE_ATTACHMENT_BUFFER_ID, type SurfaceAttachmentBufferData } from "../../src/buffers/surfaceAttachment";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../../src/buffers/surfaceProvider";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createCharacterControllerSystem } from "../../src/systems/characterController";
import { createForceFieldSystem } from "../../src/systems/forceField";
import { createSurfaceConstrainedVelocitySystem } from "../../src/systems/surfaceConstrainedVelocity";
import { createVolumetricConstrainedVelocitySystem } from "../../src/systems/volumetricConstrainedVelocity";
import { createTangentInputMapperSystem } from "../../src/systems/tangentInputMapper";
import { PlaneSurfaceProvider } from "../../src/world/parametricSurfaceProvider";

/**
 * Per-tick test harness: ForceField → TangentInputMapper → Controller →
 * SurfaceConstrainedVelocity → VolumetricConstrainedVelocity. Drives the surface-frame
 * solver end-to-end against a real `PlaneSurfaceProvider` (configurable slope, friction,
 * and per-surface stiffness caps). No synthetic-sample stand-ins — each test exercises
 * the full integration pipeline a runtime would use. See
 * `wiki/worldgen-demo-no-silent-fallbacks-in-tests.md`.
 */
interface SetupOpts {
  /** Tilt around the world X axis (radians). 0 → flat plane, normal=+Y.
   *  Positive → surface tilts up in −Z (rising toward camera at yaw=0). */
  slopeRad?: number;
  friction?: number;
  normalInMax?: number;
  normalOutMax?: number;
}

function setup(opts?: SetupOpts) {
  const slope = opts?.slopeRad ?? 0;
  const PATCH = 200; // 200×200m plane so tests can run forward at 8 m/s for many seconds.
  // Tilted plane: extentU along world +X, extentV in the (Y, −Z) plane rotated by `slope`.
  //   cross(extentU, extentV) ∝ (0, +cos(slope), +sin(slope)) — the desired normal.
  //   Origin placed so sample(0.5, 0.5) = (0, 0, 0): the character spawns above world origin.
  const provider = new PlaneSurfaceProvider({
    id: "test-plane",
    origin: [-PATCH / 2, -(PATCH / 2) * Math.sin(slope), (PATCH / 2) * Math.cos(slope)],
    extentU: [PATCH, 0, 0],
    extentV: [0, PATCH * Math.sin(slope), -PATCH * Math.cos(slope)],
    friction: opts?.friction ?? 1,
    normalInMax: opts?.normalInMax ?? 800,
    normalOutMax: opts?.normalOutMax ?? 200,
  });

  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createForceFieldSystem());
  reg.registerSystem(createTangentInputMapperSystem());
  reg.registerSystem(createCharacterControllerSystem());
  reg.registerSystem(createSurfaceConstrainedVelocitySystem());
  reg.registerSystem(createVolumetricConstrainedVelocitySystem());

  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
  const ci = reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID);
  const t = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  const v = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
  const sa = reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);
  const sp = reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID);

  // Register the provider so UV integration can sample it.
  writeBuffer(sp, (d) => { d.heightmap = provider; });

  const id = 1;
  const sample = provider.sampleAtUV(0.5, 0.5);
  const radius = DEFAULT_PLAYER_PROFILE.bodyRadius;

  writeBuffer(cc, (d) => {
    d.byEntity.set(id, {
      state: "surfaceRun",
      locomotionMode: "surfaceConstrained",
      profileId: DEFAULT_PLAYER_PROFILE.id,
      lastTransitionReason: "spawn",
      transitions: [],
      timeInState: 0,
      yawVel: 0,
      targetYaw: 0,
      bodyUpCurrent: [0, 0, 0, 1],
      bodyUpWorld: [0, 1, 0],
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      desiredFacingTangent: [0, 0, -1],
      jumpHolding: false,
      jumpDir: [0, 0, 0],
      jumpImpulseMagMax: 0,
      jumpImpulseApplied: 0,
    });
  });
  writeBuffer(ci, (d) => { d.byEntity.set(id, emptyInput(0)); });
  // Start the body at sample + radius·N so the integrator's first reconstruction is
  // consistent with the spawn point.
  writeBuffer(t, (d) => {
    d.byEntity.set(id, {
      position: [
        sample.position[0] + sample.normal[0] * radius,
        sample.position[1] + sample.normal[1] * radius,
        sample.position[2] + sample.normal[2] * radius,
      ],
      yaw: 0,
      scale: 1,
    });
  });
  writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [0, 0, 0], prevLinear: [0, 0, 0] }); });
  writeBuffer(sa, (d) => {
    d.byEntity.set(id, {
      surfaceId: provider.id,
      uv: [0.5, 0.5],
      offsetAlongNormal: radius,
      sample,
    });
  });

  const g = buildExecutionGraph({
    id: "g",
    nodes: [
      "forceFieldSystem",
      "tangentInputMapperSystem",
      "characterControllerSystem",
      "surfaceConstrainedVelocitySystem",
      "volumetricConstrainedVelocitySystem",
    ],
    registry: reg,
  });
  return { reg, cc, ci, t, v, sa, g, id, provider };
}

function tick(g: ReturnType<typeof buildExecutionGraph>, reg: ReturnType<typeof createRegistry>, dt = 0.016, now = 0) {
  executeGraph(g, reg, { dt, now });
}

describe("CharacterControllerSystem (FSM core)", () => {
  it("KeyW (forward) on surfaceRun produces forward velocity (along -Z at yaw=0)", () => {
    const { reg, ci, v, g, id } = setup();
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1 }); });
    // Several ticks to converge through the friction-grip cap.
    for (let i = 0; i < 60; i++) tick(g, reg, 0.05);
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    expect(lin[2]).toBeLessThan(-0.5); // moved along -Z
    expect(Math.abs(lin[0])).toBeLessThan(0.001); // no lateral velocity
  });

  it("jumpPressed on surfaceRun → state=airborne, step-1 impulse applied", () => {
    const { reg, ci, v, cc, g, id } = setup();
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), jumpPressed: true, jumpHeld: true, jumpHoldSec: 0 }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("airborne");
    expect(after.locomotionMode).toBe("volumeConstrained");
    expect(after.jumpHolding).toBe(true);
    // Press fires the first step of the impulse along the jump direction.
    // Neutral stick + stationary char → target velocity = (0, jumpUpSpeed, 0),
    // current = (0, 0, 0), impulse_mag = jumpUpSpeed, step = jumpUpSpeed / steps.
    const expectedStep = DEFAULT_PLAYER_PROFILE.jump.upSpeed / DEFAULT_PLAYER_PROFILE.jump.stepCount;
    expect(readBuffer(v).byEntity.get(id)!.linear[1]).toBeCloseTo(expectedStep, 4);
    expect(after.jumpImpulseMagMax).toBeCloseTo(DEFAULT_PLAYER_PROFILE.jump.upSpeed, 4);
    expect(after.jumpImpulseApplied).toBeCloseTo(expectedStep, 4);
  });

  it("jump held through full window: vertical velocity reaches jumpUpSpeed", () => {
    const { reg, ci, v, g, id } = setup();
    // Press and hold for a tick.
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), jumpPressed: true, jumpHeld: true, jumpHoldSec: 0 }); });
    tick(g, reg, 0.016);
    // Continue holding; release of jumpPressed (edge), still jumpHeld.
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), jumpPressed: false, jumpHeld: true, jumpHoldSec: 0.016 }); });
    // Tick past the hold window. jumpHoldMaxSec = 0.18, plenty of margin at dt=0.016.
    const dt = 0.016;
    for (let i = 0; i < 12; i++) tick(g, reg, dt);
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    // After the full window: 4 steps × jumpUpSpeed/4 = jumpUpSpeed delivered;
    // gravity drag applied on every airborne tick (12 ticks past press; the press
    // tick itself doesn't drag because the surface reaction neutralized the
    // accumulator before transitioning to airborne).
    const gravity = 9.81;
    const airbornePostPressTicks = 12;
    const expectedY = DEFAULT_PLAYER_PROFILE.jump.upSpeed - gravity * airbornePostPressTicks * dt;
    expect(lin[1]).toBeCloseTo(expectedY, 1);
  });

  it("jump tap (release before window closes): jumpHolding stops; impulse partial", () => {
    const { reg, ci, v, cc, g, id } = setup();
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), jumpPressed: true, jumpHeld: true, jumpHoldSec: 0 }); });
    tick(g, reg, 0.016);
    // Release the button on the next tick.
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), jumpPressed: false, jumpReleased: true, jumpHeld: false }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.jumpHolding).toBe(false);
    // Applied impulse should be less than full magnitude — the player let go early.
    expect(after.jumpImpulseApplied).toBeLessThan(after.jumpImpulseMagMax);
    expect(after.jumpImpulseApplied).toBeGreaterThan(0);
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    // v.y < full jumpUpSpeed (and adjusted by 2 ticks of gravity).
    expect(lin[1]).toBeLessThan(DEFAULT_PLAYER_PROFILE.jump.upSpeed);
  });

  it("jump press with forward stick at speed: forward kick ADDED to current velocity", () => {
    const { reg, ci, v, g, id } = setup();
    // Seed velocity at full run speed forward (-Z).
    writeBuffer(v, (d) => {
      const entry = d.byEntity.get(id)!;
      entry.linear[0] = 0; entry.linear[1] = 0; entry.linear[2] = -DEFAULT_PLAYER_PROFILE.desiredRunSpeed;
      d.byEntity.set(id, entry);
    });
    writeBuffer(ci, (d) => {
      d.byEntity.set(id, { ...emptyInput(0), moveY: 1, jumpPressed: true, jumpHeld: true, jumpHoldSec: 0 });
    });
    // Tick once for press + step1; hold through full window for full impulse.
    const dt = 0.016;
    for (let i = 0; i < 14; i++) {
      tick(g, reg, dt);
      // After first tick clear jumpPressed edge.
      writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1, jumpPressed: false, jumpHeld: true, jumpHoldSec: i * dt }); });
    }
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    // Additive impulse: current horizontal (8 forward) + jump.horizSpeed kick
    // (4 forward) = 12 m/s.
    const horizMag = Math.hypot(lin[0], lin[2]);
    expect(horizMag).toBeGreaterThan(11);
    expect(horizMag).toBeLessThan(13);
  });

  it("jump press with backward stick at full forward speed: kick SUBTRACTS from current velocity", () => {
    const { reg, ci, v, g, id } = setup();
    writeBuffer(v, (d) => {
      const entry = d.byEntity.get(id)!;
      entry.linear[0] = 0; entry.linear[1] = 0; entry.linear[2] = -DEFAULT_PLAYER_PROFILE.desiredRunSpeed;
      d.byEntity.set(id, entry);
    });
    writeBuffer(ci, (d) => {
      d.byEntity.set(id, { ...emptyInput(0), moveY: -1, jumpPressed: true, jumpHeld: true, jumpHoldSec: 0 });
    });
    tick(g, reg, 0.016);
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: -1, jumpPressed: false, jumpHeld: true, jumpHoldSec: 0.016 }); });
    for (let i = 0; i < 12; i++) tick(g, reg, 0.016);
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    // Additive impulse: current (-8 forward) + kick (+4 back) = -4 in Z.
    // Forward velocity is reduced but not reversed (kick < current).
    expect(lin[2]).toBeGreaterThan(-6);
    expect(lin[2]).toBeLessThan(-2);
  });

  it("jump pressing into a steep slope: impulse direction is tangent (no into-surface component)", () => {
    // 70° slope (~1.22 rad). Surface normal tilts strongly back in +Z.
    // Without the tangent clamp, joystick-forward into the slope would push
    // impulse partly INTO the slope (in -N direction). The clamp projects
    // out that component so the body either jumps tangent-to-slope (climb
    // up the hill) or straight up.
    const slopeRad = 1.22;
    const { reg, ci, cc, g, id } = setup({ slopeRad, friction: 1, normalOutMax: 1000 });
    // Press forward (uphill) + jump on the first tick.
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1, jumpPressed: true, jumpHeld: true, jumpHoldSec: 0 }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("airborne");
    // jumpDir should be tangent to the surface normal (dot ≈ 0 or positive).
    // The surface normal here is (0, cos(slopeRad), sin(slopeRad)).
    const Nx = 0, Ny = Math.cos(slopeRad), Nz = Math.sin(slopeRad);
    const dotDirN = after.jumpDir[0] * Nx + after.jumpDir[1] * Ny + after.jumpDir[2] * Nz;
    expect(dotDirN).toBeGreaterThanOrEqual(-1e-3); // no into-surface component (small ε for FP)
  });

  it("steep slope transitions surfaceRun → surfaceSlide", () => {
    // Use a normal that's actually consistent with slopeRad ≈ 1.2 (~69°).
    // normal = (0, cos(1.2), sin(1.2)) — surface tilts toward +Z.
    const { reg, cc, g } = setup({ slopeRad: 1.2 });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(1)!;
    expect(after.state).toBe("surfaceSlide");
    expect(after.lastTransitionReason).toMatch(/slope|grip/);
  });

  it("flat ground, forward input: total |v| converges near desiredRunSpeed in tangent plane", () => {
    const { reg, ci, v, g, id } = setup();
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1 }); });
    for (let i = 0; i < 200; i++) tick(g, reg, 0.05);
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    const speed = Math.hypot(lin[0], lin[1], lin[2]);
    // Steady-state speed is bounded by gripBudget (= μ·|g| = 9.81 m/s²) over response
    // dt; with desiredRunSpeed = 8 we should land near it.
    expect(speed).toBeGreaterThan(7.5);
    expect(speed).toBeLessThan(8.5);
    expect(Math.abs(lin[1])).toBeLessThan(0.05); // no significant vertical drift on flat
  });

  it("30° slope with forward input: some velocity goes vertical, total |v| ≤ desiredRunSpeed", () => {
    // Surface normal tilts toward +Z so the slope rises in -Z. Input forward (-Z) walks uphill.
    const { reg, ci, v, g, id } = setup({ slopeRad: Math.PI / 6 });
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1 }); });
    for (let i = 0; i < 200; i++) tick(g, reg, 0.05);
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    const speed = Math.hypot(lin[0], lin[1], lin[2]);
    expect(speed).toBeLessThan(DEFAULT_PLAYER_PROFILE.desiredRunSpeed + 0.5);
    expect(lin[1]).toBeGreaterThan(0.5); // climbing — vertical component is positive
    // Horizontal world XZ component < total speed (some budget went vertical)
    const horizontal = Math.hypot(lin[0], lin[2]);
    expect(horizontal).toBeLessThan(speed);
  });

  it("brake: no input on flat surface decays initial velocity to ~0 within ~1s", () => {
    const { reg, v, g, id } = setup();
    writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [5, 0, 0], prevLinear: [5, 0, 0] }); });
    for (let i = 0; i < 100; i++) tick(g, reg, 0.02);
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    const speed = Math.hypot(lin[0], lin[1], lin[2]);
    expect(speed).toBeLessThan(0.5);
  });

  it("icy surface (low friction) under hard input → state transitions to surfaceSlide", () => {
    const { reg, ci, cc, g, id } = setup({ friction: 0.05 });
    // Strong forward input — desired tangent accel exceeds (μ × |g_N|) = 0.05 × 9.81 ≈ 0.49.
    // The state-transition slip check fires when required tangent accel > grip × slideGripScale.
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1 }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("surfaceSlide");
    expect(after.lastTransitionReason).toContain("grip");
  });

  it("low normalOutMax → required suction exceeds cap → detach to airborne", () => {
    // Pre-load v with strong upward velocity. Pinning v_N to 0 requires a large negative
    // normal accel; surface can't pull that hard → detach.
    const { reg, v, cc, g, id } = setup({ normalOutMax: 1 });
    writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [0, 50, 0], prevLinear: [0, 50, 0] }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("airborne");
    expect(after.locomotionMode).toBe("volumeConstrained");
    expect(after.lastTransitionReason).toContain("detach");
  });

  // ===== Climb + slide transitions (Phase 2 FSM refactor) =====
  //
  // Triggers under test:
  //   • run/slide → climb : tangentSpeed < climb.engagementMaxSpeed AND slope > slopeRunMaxRad
  //   • climb → surfaceRun : slope < slopeStandMaxRad (hysteresis with engagement)
  //   • climb → surfaceSlide : tangentSpeed > climb.engagementMaxSpeed × 1.5
  //   • surfaceRun → surfaceSlide : over-speed (tangentSpeed > forwardAccel.vMax × 1.1)
  //   • surfaceRun → surfaceSlide : backslide (intent vs vel opposing AND net foot
  //     accel in intent direction ≤ 0)
  //
  // Reference: [[worldgen-demo-fsm-transitions-as-the-primary-mechanic]],
  // [[worldgen-demo-slip-criteria-2026-05-18]] (note: that memory predates the
  // 2026-05-18 backslide-only refinement — superseded by code here).

  it("steep slope + low tangent speed → surfaceRun transitions to climb (grab)", () => {
    // 1.2 rad slope (~69°) > slopeRunMaxRad (0.9); body stationary → climb.
    const { reg, cc, g } = setup({ slopeRad: 1.2 });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(1)!;
    expect(after.state).toBe("climb");
    expect(after.lastTransitionReason).toContain("grab");
    // Validate the full FSM path: spawn (surfaceRun) → climb in one tick.
    expect(after.transitions).toHaveLength(1);
    expect(after.transitions[0].from).toBe("surfaceRun");
    expect(after.transitions[0].to).toBe("climb");
    expect(after.transitions[0].reason).toMatch(/grab/);
  });

  it("climb → surfaceRun when slope eases below slopeStandMaxRad", () => {
    // Start on a 1.2 rad slope so engagement fires.
    const { reg, cc, g, id, sa, provider } = setup({ slopeRad: 1.2 });
    tick(g, reg, 0.016);
    expect(readBuffer(cc).byEntity.get(id)!.state).toBe("climb");

    // Swap the surface to a shallow slope (0.5 rad ≈ 29° < slopeStandMaxRad).
    // Re-write the attachment's sample to reflect the easier slope.
    const shallowSample = {
      ...provider.sampleAtUV(0.5, 0.5),
      normal: [0, Math.cos(0.5), Math.sin(0.5)] as [number, number, number],
    };
    writeBuffer(sa, (d) => {
      const att = d.byEntity.get(id)!;
      d.byEntity.set(id, {
        ...att,
        sample: shallowSample,
      });
    });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("surfaceRun");
    expect(after.lastTransitionReason).toContain("eased");
    // FSM path: surfaceRun → climb → surfaceRun.
    expect(after.transitions.map((t) => `${t.from}→${t.to}`)).toEqual([
      "surfaceRun→climb",
      "climb→surfaceRun",
    ]);
    expect(after.transitions[1].reason).toMatch(/eased/);
  });

  it("over-speed on flat surface → surfaceRun transitions to surfaceSlide", () => {
    // Seed velocity 1.5× forwardAccel.vMax (12 m/s when vMax=8). Should slip.
    const { reg, cc, v, g, id } = setup();
    const vMax = DEFAULT_PLAYER_PROFILE.forwardAccel.vMax;
    writeBuffer(v, (d) => {
      d.byEntity.set(id, { linear: [0, 0, -vMax * 1.5], prevLinear: [0, 0, -vMax * 1.5] });
    });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("surfaceSlide");
    expect(after.lastTransitionReason).toContain("over-speed");
    // FSM path: spawn (surfaceRun) → surfaceSlide in one tick.
    expect(after.transitions).toHaveLength(1);
    expect(after.transitions[0].from).toBe("surfaceRun");
    expect(after.transitions[0].to).toBe("surfaceSlide");
    expect(after.transitions[0].reason).toMatch(/over-speed/);
  });

  it("icy flat surface with steady input does NOT slip (no more grip-budget trigger)", () => {
    // Old design slipped here; new design says feet just accelerate slowly,
    // capped by grip budget. Body stays in surfaceRun — no transitions.
    // [[worldgen-demo-slip-criteria-2026-05-18]] — superseded.
    const { reg, ci, cc, g, id } = setup({ friction: 0.05 });
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1 }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("surfaceRun");
    // No state changes — transitions log should be empty.
    expect(after.transitions).toHaveLength(0);
  });

  it("low normalInMax → required reaction exceeds cap → ragdoll → airborne (V1)", () => {
    // Pre-load v with strong downward velocity. Pinning v_N to 0 requires a large positive
    // normal accel; surface stiffness exceeded → ragdoll. V1 redirects to airborne.
    const { reg, v, cc, g, id } = setup({ normalInMax: 1 });
    writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [0, -50, 0], prevLinear: [0, -50, 0] }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("airborne");
    expect(after.locomotionMode).toBe("volumeConstrained");
    expect(after.lastTransitionReason).toContain("smack");
  });
});
