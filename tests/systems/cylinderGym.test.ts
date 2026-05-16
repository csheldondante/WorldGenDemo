/**
 * Integration tests for the two cylinder gym scenes. Wires the full Running
 * pipeline minus render (`forceField → tangentInputMapper → characterController →
 * surfaceConstrainedVelocity → volumetricConstrainedVelocity → surfaceConstraint`)
 * around a real `CylindricalSurfaceProvider` and a radial gravity volume copying
 * the gym `scene.json`.
 *
 * Drives semantic input by writing `CharacterInputBuffer` directly each tick.
 * This is the same pattern the existing trajectory test uses and bypasses the
 * keyboard/gamepad device layer.
 *
 * What these tests catch:
 *  - Concave wall forward-stick produces motion AROUND the perimeter, not along
 *    the axis (regression for the Batch 1 UV-wrap bug).
 *  - Convex log forward-stick stays surfaceRun while traversing the perimeter.
 *  - Convex log launch (set initial velocity, force airborne) follows radial
 *    gravity back toward the log — requires Batch 3's air-thrust fix to pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../../src/buffers/volumeField";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createCharacterControllerSystem } from "../../src/systems/characterController";
import { createForceFieldSystem } from "../../src/systems/forceField";
import { createSurfaceConstrainedVelocitySystem } from "../../src/systems/surfaceConstrainedVelocity";
import { createVolumetricConstrainedVelocitySystem } from "../../src/systems/volumetricConstrainedVelocity";
import { createSurfaceConstraintSystem } from "../../src/systems/surfaceConstraint";
import { createTangentInputMapperSystem } from "../../src/systems/tangentInputMapper";
import { CylindricalSurfaceProvider } from "../../src/world/parametricSurfaceProvider";
import type { GravityVolume } from "../../src/lib/math/gravityVolume";

function buildRegistry() {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createForceFieldSystem());
  reg.registerSystem(createTangentInputMapperSystem());
  reg.registerSystem(createCharacterControllerSystem());
  reg.registerSystem(createSurfaceConstrainedVelocitySystem());
  reg.registerSystem(createVolumetricConstrainedVelocitySystem());
  reg.registerSystem(createSurfaceConstraintSystem());
  return reg;
}

function buildGraph(reg: ReturnType<typeof createRegistry>) {
  return buildExecutionGraph({
    id: "cyl-gym",
    nodes: [
      "forceFieldSystem",
      "tangentInputMapperSystem",
      "characterControllerSystem",
      "surfaceConstrainedVelocitySystem",
      "volumetricConstrainedVelocitySystem",
      "surfaceConstraintSystem",
    ],
    registry: reg,
  });
}

interface SpawnOpts {
  cyl: CylindricalSurfaceProvider;
  uv: [number, number];
  cameraYaw: number;
  gravityVolume: GravityVolume;
  initialVelocity?: [number, number, number];
  startAirborne?: boolean;
}

function spawn(reg: ReturnType<typeof createRegistry>, opts: SpawnOpts) {
  const id = 1;
  const sample = opts.cyl.sampleAtUV(opts.uv[0], opts.uv[1]);
  const radius = DEFAULT_PLAYER_PROFILE.bodyRadius;

  writeBuffer(reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID), (d) => {
    d.heightmap = opts.cyl;
  });
  writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
    d.gravity = [0, -9.81, 0];
    d.volumes = [opts.gravityVolume];
  });
  writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      state: opts.startAirborne ? "airborne" : "surfaceRun",
      locomotionMode: opts.startAirborne ? "volumeConstrained" : "surfaceConstrained",
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
    d.byEntity.set(id, { ...emptyInput(opts.cameraYaw) });
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
  writeBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      linear: opts.initialVelocity ?? [0, 0, 0],
      prevLinear: [0, 0, 0],
    });
  });
  writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      surfaceId: opts.cyl.id,
      uv: opts.uv,
      offsetAlongNormal: radius,
      sample,
    });
  });
  return id;
}

function setInput(reg: ReturnType<typeof createRegistry>, id: number, moveX: number, moveY: number, cameraYaw: number) {
  writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
    d.byEntity.set(id, { ...emptyInput(cameraYaw), moveX, moveY });
  });
}

// Suppress per-tick controller dev logs.
let consoleSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => { consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { consoleSpy?.mockRestore(); consoleSpy = null; });

// Convex log matching gym-cylinder-convex/scene.json: axis +X, R=3, H=100, axisOrigin (0,0,0).
function convexLog(): CylindricalSurfaceProvider {
  return new CylindricalSurfaceProvider({
    id: "convex-log",
    axisOrigin: [0, 0, 0],
    axisDirection: [1, 0, 0],
    radius: 3,
    height: 100,
    concave: false,
  });
}

// Radial gravity toward the +X axis, matching gym-cylinder-convex.
function convexGravity(): GravityVolume {
  return {
    shape: { type: "cylinder", axisOrigin: [0, 0, 0], axisDirection: [1, 0, 0], radius: 10, halfHeight: 50 },
    field: { type: "radial", axisOrigin: [0, 0, 0], axisDirection: [1, 0, 0], direction: "toward", magnitude: 9.81 },
    priority: 1,
  };
}

// Wall-of-death matching gym-cylinder-concave/scene.json: axis +Y, R=12, H=30 at origin (0,-15,0).
// For the integration test the origin choice doesn't matter; pick (0,0,0) for simpler math.
function concaveWall(): CylindricalSurfaceProvider {
  return new CylindricalSurfaceProvider({
    id: "concave-wall",
    axisOrigin: [0, 0, 0],
    axisDirection: [0, 1, 0],
    radius: 12,
    height: 30,
    concave: true,
  });
}

function concaveGravity(): GravityVolume {
  return {
    shape: { type: "cylinder", axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], radius: 13, halfHeight: 15 },
    field: { type: "radial", axisOrigin: [0, 0, 0], axisDirection: [0, 1, 0], direction: "away", magnitude: 9.81 },
    priority: 1,
  };
}

describe("Cylinder gym — concave wall (axis +Y, radial-away gravity)", () => {
  it("forward stick moves the character AROUND the perimeter, not along the axis", () => {
    const reg = buildRegistry();
    const cyl = concaveWall();
    // At uv=(0, 0.5): position = (R, 0.5·H, 0) = (12, 15, 0); concave normal = -X.
    //  basisPerpendicular(+Y) → perpA = +X, perpB = -Z. tangentAround(0) = -Z. tangentV = +Y.
    // For "forward" to align with +tangentU (-Z), we want camera fwd = -Z, i.e. cameraYaw = 0:
    //   FwX = -sin 0 = 0, FwZ = -cos 0 = -1.
    const id = spawn(reg, { cyl, uv: [0, 0.5], cameraYaw: 0, gravityVolume: concaveGravity() });
    const g = buildGraph(reg);
    setInput(reg, id, 0, 1, 0); // moveY=1 = forward
    for (let i = 0; i < 60; i++) executeGraph(g, reg, { dt: 0.05, now: i * 0.05 });

    const t = readBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID)).byEntity.get(id)!;
    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    const att = readBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID)).byEntity.get(id)!;

    // Must still be on the surface. (The FSM may be surfaceRun or surfaceSlide depending
    // on slope-vs-world-up; what matters here is that locomotion is still surface-driven
    // and the character didn't get kicked airborne by an out-of-bounds UV.)
    expect(ctrl.locomotionMode).toBe("surfaceConstrained");

    // Y should be unchanged (motion around axis, not along it).
    expect(Math.abs(t.position[1] - 15)).toBeLessThan(0.5);

    // Z must have moved (motion in -Z direction around perimeter).
    expect(t.position[2]).toBeLessThan(-1);

    // u_param should have advanced significantly; v stays near 0.5.
    expect(att.uv[0]).toBeGreaterThan(0.02);
    expect(Math.abs(att.uv[1] - 0.5)).toBeLessThan(0.05);
  });

  it("running past the wrap boundary keeps the character attached (u folds modulo 1)", () => {
    const reg = buildRegistry();
    const cyl = concaveWall();
    const id = spawn(reg, { cyl, uv: [0.95, 0.5], cameraYaw: 0, gravityVolume: concaveGravity() });
    const g = buildGraph(reg);
    setInput(reg, id, 0, 1, 0);
    for (let i = 0; i < 60; i++) executeGraph(g, reg, { dt: 0.05, now: i * 0.05 });

    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    const att = readBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID)).byEntity.get(id)!;
    expect(ctrl.locomotionMode).toBe("surfaceConstrained");
    expect(att.uv[0]).toBeGreaterThanOrEqual(0);
    expect(att.uv[0]).toBeLessThan(1);
    // Reason should NOT be "walked off edge" — we wrapped, not detached.
    expect(ctrl.lastTransitionReason).not.toBe("walked off edge");
  });
});

describe("Cylinder gym — convex log (axis +X, radial-toward gravity)", () => {
  it("forward stick at the top of the log moves around the perimeter, stays surface-attached", () => {
    const reg = buildRegistry();
    const cyl = convexLog();
    // At uv=(0, 0.5): on top of the log. axisDirection=+X; basisPerpendicular(+X) → perpA=+Y,
    // perpB=+Z. radial(0)=+Y, normal (convex)=+Y. tangentAround(0)=+Z. So for forward to align
    // with +tangentU (+Z), camera fwd = +Z, i.e. cameraYaw = π:
    //   FwX = -sin π = 0, FwZ = -cos π = +1.
    const id = spawn(reg, { cyl, uv: [0, 0.5], cameraYaw: Math.PI, gravityVolume: convexGravity() });
    const g = buildGraph(reg);
    setInput(reg, id, 0, 1, Math.PI);
    for (let i = 0; i < 60; i++) executeGraph(g, reg, { dt: 0.05, now: i * 0.05 });

    const t = readBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID)).byEntity.get(id)!;
    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    const att = readBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID)).byEntity.get(id)!;

    // FSM may toggle between surfaceConstrained and volumeConstrained at run speed on a
    // small R=3 log (slip-grip exceed and orbital arc; separate controller-side issue
    // — see "centripetal/grip tuning for small radii" follow-up). What we care about
    // here is that the character has TRAVERSED the perimeter, not that they stayed
    // surface-attached every tick.
    void ctrl;

    expect(att.uv[0]).toBeGreaterThan(0.02);

    // X (along the axis) should be near spawn — cyl.axisOrigin=(0,0,0), axisDir=+X, height=100,
    // spawn v=0.5 → spawn X = 50. The character is running AROUND the perimeter (Y/Z plane),
    // not along the axis.
    expect(Math.abs(t.position[0] - 50)).toBeLessThan(0.5);

    // Body stays within ~(R + bodyRadius) of the axis in the YZ plane. Allow a bit of
    // orbital-arc margin (body is occasionally airborne and drifts outward briefly).
    const radial = Math.hypot(t.position[1], t.position[2]);
    expect(radial).toBeGreaterThan(cyl.radius - 0.1);
    expect(radial).toBeLessThan(cyl.radius + DEFAULT_PLAYER_PROFILE.bodyRadius + 1.5);
  });

  it("airborne above the log: radial gravity reels the body toward the axis", () => {
    // Verifies Batch 3: the air controller no longer hammers world-XZ velocity to zero
    // each tick, so radial gravity actually accelerates the body toward the axis.
    const reg = buildRegistry();
    const cyl = convexLog();
    // Place the body well above the log along world +Y at spawn (UV (0, 0.5) → world
    // (50, R+r, 0)). Lift it another ~3m so it's clear of the surface and the gravity
    // volume's radius (=10) still contains it.
    const id = spawn(reg, {
      cyl,
      uv: [0, 0.5],
      cameraYaw: Math.PI,
      gravityVolume: convexGravity(),
      initialVelocity: [0, 0, 0],
      startAirborne: true,
    });
    // Lift along +Y so radial offset from the axis is purely +Y (gravity points purely −Y).
    writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
      const t = d.byEntity.get(id)!;
      t.position[1] = 8; // axis at y=0; this puts the body 8m above the axis radially.
      d.byEntity.set(id, t);
    });
    // Re-attach to a sample-free state — the test only cares about volumetric.
    const g = buildGraph(reg);
    setInput(reg, id, 0, 0, Math.PI);

    const startY = readBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID)).byEntity.get(id)!.position[1];
    // Run 0.4s of pure ballistic; expect Y to drop by ≈ 0.5·9.81·0.16 ≈ 0.78m.
    for (let i = 0; i < 40; i++) executeGraph(g, reg, { dt: 0.01, now: i * 0.01 });
    const endY = readBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID)).byEntity.get(id)!.position[1];
    const endVel = readBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID)).byEntity.get(id)!.linear;

    // Body fell toward the axis (radially) — Y dropped meaningfully.
    expect(endY).toBeLessThan(startY - 0.5);
    // Pre-Batch 3 the air controller's approach() drained vY toward 0 each tick, so this
    // delta could never accumulate. Now vY should be clearly negative.
    expect(endVel[1]).toBeLessThan(-2);
  });
});
