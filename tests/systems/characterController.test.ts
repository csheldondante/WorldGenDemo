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

  it("jumpPressed on surfaceRun → state=airborne and v.y=jumpImpulse", () => {
    const { reg, ci, v, cc, g, id } = setup();
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), jumpPressed: true, jumpHeld: true, jumpHoldSec: 0 }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("airborne");
    expect(after.locomotionMode).toBe("volumeConstrained");
    // Surface reaction canceled gravity-normal *before* the jump fired this tick, so the
    // net accumulator on integration is zero — v.y comes out exactly at jumpImpulse.
    expect(readBuffer(v).byEntity.get(id)!.linear[1]).toBeCloseTo(DEFAULT_PLAYER_PROFILE.jumpImpulse, 5);
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

  it("icy surface (low friction) under hard input → still surfaceRun; thrust is grip-limited, not a slip trigger", () => {
    const { reg, ci, cc, g, id } = setup({ friction: 0.05 });
    // Strong forward input on low-friction ground. The controller's
    // clampToRange caps applied force at the grip budget (~0.5 m/s² here);
    // the character accelerates slowly but is NOT slipping. The FSM stays
    // in surfaceRun. (Earlier behavior fired surfaceSlide on every transient
    // because the rule compared the uncapped REQUEST to the budget — that
    // was a bug; the cap already enforces friction at the application step.)
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1 }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("surfaceRun");
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
