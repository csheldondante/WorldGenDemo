/**
 * Verifies that closed surfaces (cylinder, torus) wrap their UV at integration time
 * instead of triggering "walked off edge" detach. Drives
 * SurfaceConstrainedVelocity + SurfaceConstraint with a cylindrical provider and a
 * pre-set tangent velocity that would push u_raw past 1 in one tick.
 *
 * Without the wrap-aware folding (added in cylinder Batch 1) the character would
 * detach to airborne the moment u crosses 1; with it, u folds modulo 1 and the
 * character stays surface-constrained.
 */
import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../../src/buffers/characterController";
import { CHARACTER_INPUT_BUFFER_ID, type CharacterInputBufferData, emptyInput } from "../../src/buffers/characterInput";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../../src/buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../../src/buffers/velocity";
import { SURFACE_ATTACHMENT_BUFFER_ID, type SurfaceAttachmentBufferData } from "../../src/buffers/surfaceAttachment";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../../src/buffers/surfaceProvider";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createSurfaceConstrainedVelocitySystem } from "../../src/systems/surfaceConstrainedVelocity";
import { createVolumetricConstrainedVelocitySystem } from "../../src/systems/volumetricConstrainedVelocity";
import { createSurfaceConstraintSystem } from "../../src/systems/surfaceConstraint";
import { CylindricalSurfaceProvider } from "../../src/world/parametricSurfaceProvider";

describe("Closed-surface UV wrapping", () => {
  it("cylinder: integrator folds u_raw modulo 1, surfaceConstraint does not detach", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createSurfaceConstrainedVelocitySystem());
    reg.registerSystem(createVolumetricConstrainedVelocitySystem());
    reg.registerSystem(createSurfaceConstraintSystem());

    // Vertical-axis concave cylinder, R=12, H=30 (matches gym-cylinder-concave).
    const cyl = new CylindricalSurfaceProvider({
      id: "wrap-test",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      radius: 12,
      height: 30,
      concave: true,
    });

    const id = 1;
    const startU = 0.95; // just before the wrap boundary
    const sample = cyl.sampleAtUV(startU, 0.5);
    const radius = DEFAULT_PLAYER_PROFILE.bodyRadius;

    writeBuffer(reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID), (d) => {
      d.heightmap = cyl;
    });
    writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
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
    writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
      d.byEntity.set(id, emptyInput(0));
    });
    writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
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
    // Velocity along +tangentU at a speed that, over dt=0.05, pushes u past 1.
    // tangentUNorm = 2π·12 ≈ 75.4; vTangent · dt / TUNorm = v · 0.05 / 75.4.
    // For v = 200 m/s the step is ~0.133 → u_raw = 0.95 + 0.133 = 1.083 → wraps to 0.083.
    const tU = sample.tangentU;
    writeBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID), (d) => {
      d.byEntity.set(id, {
        linear: [tU[0] * 200, tU[1] * 200, tU[2] * 200],
        prevLinear: [0, 0, 0],
      });
    });
    writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
      d.byEntity.set(id, {
        surfaceId: cyl.id,
        uv: [startU, 0.5],
        offsetAlongNormal: radius,
        sample,
      });
    });

    const g = buildExecutionGraph({
      id: "wrap",
      nodes: [
        "surfaceConstrainedVelocitySystem",
        "volumetricConstrainedVelocitySystem",
        "surfaceConstraintSystem",
      ],
      registry: reg,
    });

    executeGraph(g, reg, { dt: 0.05, now: 0 });

    const att = readBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID)).byEntity.get(id)!;
    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;

    // u should have wrapped into [0, 1) — not landed at 1.083 or been clamped to 1.
    expect(att.uv[0]).toBeGreaterThanOrEqual(0);
    expect(att.uv[0]).toBeLessThan(1);
    expect(att.uv[0]).toBeLessThan(0.2); // and should be the post-wrap small value
    expect(ctrl.state).toBe("surfaceRun");
    expect(ctrl.locomotionMode).toBe("surfaceConstrained");
  });

  it("cylinder: v out-of-bounds still triggers walked-off-edge (axis ends are not closed)", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createSurfaceConstrainedVelocitySystem());
    reg.registerSystem(createVolumetricConstrainedVelocitySystem());
    reg.registerSystem(createSurfaceConstraintSystem());

    const cyl = new CylindricalSurfaceProvider({
      id: "end-test",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      radius: 12,
      height: 30,
      concave: true,
    });

    const id = 1;
    const startV = 0.98;
    const sample = cyl.sampleAtUV(0.5, startV);
    const radius = DEFAULT_PLAYER_PROFILE.bodyRadius;

    writeBuffer(reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID), (d) => { d.heightmap = cyl; });
    writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
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
    writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
      d.byEntity.set(id, emptyInput(0));
    });
    writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
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
    // Velocity along +tangentV at 200 m/s for dt=0.05 — pushes v past 1.
    const tV = sample.tangentV;
    writeBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID), (d) => {
      d.byEntity.set(id, {
        linear: [tV[0] * 200, tV[1] * 200, tV[2] * 200],
        prevLinear: [0, 0, 0],
      });
    });
    writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
      d.byEntity.set(id, {
        surfaceId: cyl.id,
        uv: [0.5, startV],
        offsetAlongNormal: radius,
        sample,
      });
    });

    const g = buildExecutionGraph({
      id: "vend",
      nodes: [
        "surfaceConstrainedVelocitySystem",
        "volumetricConstrainedVelocitySystem",
        "surfaceConstraintSystem",
      ],
      registry: reg,
    });

    executeGraph(g, reg, { dt: 0.05, now: 0 });

    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    expect(ctrl.state).toBe("airborne");
    expect(ctrl.locomotionMode).toBe("volumeConstrained");
    expect(ctrl.lastTransitionReason).toBe("walked off edge");
  });
});
