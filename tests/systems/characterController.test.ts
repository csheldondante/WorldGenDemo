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
import type { SurfaceSample } from "../../src/world/surfaceProvider";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createCharacterControllerSystem } from "../../src/systems/characterController";
import { createForceFieldSystem } from "../../src/systems/forceField";
import { createVelocityIntegrationSystem } from "../../src/systems/velocityIntegration";

/**
 * Per-tick test harness: ForceField → Controller → VelocityIntegration.
 * Drives the surface-frame solver end-to-end. Gravity comes from VolumeFieldBuffer's
 * default (-9.81 on Y), so the surface gets a normal-force budget for grip.
 */
function setup(opts?: { sample?: Partial<SurfaceSample> }) {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createForceFieldSystem());
  reg.registerSystem(createCharacterControllerSystem());
  reg.registerSystem(createVelocityIntegrationSystem());
  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
  const ci = reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID);
  const t = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  const v = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
  const sa = reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);

  const id = 1;
  writeBuffer(cc, (d) => {
    d.byEntity.set(id, {
      state: "surfaceRun",
      locomotionMode: "surfaceConstrained",
      profileId: DEFAULT_PLAYER_PROFILE.id,
      lastTransitionReason: "spawn",
      timeInState: 0,
      jumpHeldLastTick: false,
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
    });
  });
  writeBuffer(ci, (d) => { d.byEntity.set(id, emptyInput(0)); });
  writeBuffer(t, (d) => { d.byEntity.set(id, { position: [0, 1, 0], yaw: 0, scale: 1 }); });
  writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [0, 0, 0] }); });
  const baseSample = {
    position: [0, 0, 0] as [number, number, number],
    normal: [0, 1, 0] as [number, number, number],
    tangentU: [1, 0, 0] as [number, number, number],
    tangentV: [0, 0, 1] as [number, number, number],
    slopeRad: 0,
    friction: 1,
    normalInMax: 800,
    normalOutMax: 200,
    traversable: true,
  };
  writeBuffer(sa, (d) => {
    d.byEntity.set(id, {
      surfaceId: "test", uv: [0.5, 0.5], offsetAlongNormal: 0.5,
      sample: { ...baseSample, ...(opts?.sample ?? {}) },
    });
  });
  const g = buildExecutionGraph({
    id: "g",
    nodes: ["forceFieldSystem", "characterControllerSystem", "velocityIntegrationSystem"],
    registry: reg,
  });
  return { reg, cc, ci, t, v, sa, g, id };
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
    const slope = 1.2;
    const { reg, cc, g } = setup({
      sample: {
        slopeRad: slope,
        normal: [0, Math.cos(slope), Math.sin(slope)],
      },
    });
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
    const slope = Math.PI / 6; // 30°
    const { reg, ci, v, g, id } = setup({
      sample: {
        slopeRad: slope,
        normal: [0, Math.cos(slope), Math.sin(slope)],
      },
    });
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
    writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [5, 0, 0] }); });
    for (let i = 0; i < 100; i++) tick(g, reg, 0.02);
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    const speed = Math.hypot(lin[0], lin[1], lin[2]);
    expect(speed).toBeLessThan(0.5);
  });

  it("icy surface (low friction) under hard input → state transitions to surfaceSlide", () => {
    const { reg, ci, cc, g, id } = setup({ sample: { friction: 0.05 } });
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
    const { reg, v, cc, g, id } = setup({ sample: { normalOutMax: 1 } });
    writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [0, 50, 0] }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("airborne");
    expect(after.locomotionMode).toBe("volumeConstrained");
    expect(after.lastTransitionReason).toContain("detach");
  });

  it("low normalInMax → required reaction exceeds cap → ragdoll → airborne (V1)", () => {
    // Pre-load v with strong downward velocity. Pinning v_N to 0 requires a large positive
    // normal accel; surface stiffness exceeded → ragdoll. V1 redirects to airborne.
    const { reg, v, cc, g, id } = setup({ sample: { normalInMax: 1 } });
    writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [0, -50, 0] }); });
    tick(g, reg, 0.016);
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("airborne");
    expect(after.locomotionMode).toBe("volumeConstrained");
    expect(after.lastTransitionReason).toContain("smack");
  });
});
