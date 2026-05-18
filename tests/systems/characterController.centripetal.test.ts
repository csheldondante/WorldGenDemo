/**
 * Centripetal-aware leave-surface rule — integration tests against parametric surfaces.
 *
 * The rule (in characterController.ts surface block):
 *   apparent_N = external·N − centripetal·N
 *   pullDemand = apparent_N + vN/dt   (= -aSurfaceNRequired, the surface's required pull along -N)
 *   if pullDemand > evaluateLinearAccel(profile.downAccel, max(0, vN)) → detach
 *
 * For attached steady-state (vN=0), this reduces to the user's exact framing:
 *   "leave the surface if the apparent forces (external + centripetal) has a positive dot
 *    with the surface normal and is greater than the acceleration the CC allows in the
 *    anti-normal direction"
 *
 * Tests pre-populate SurfaceProviderBuffer with a parametric provider, pre-set the
 * character's SurfaceAttachment to a chosen UV, and run the controller for one tick.
 * surfaceConstraintSystem is excluded — its UV snapping for non-heightmap providers has
 * known limitations (see CylindricalSurfaceProvider.worldToUV docstring) that obscure
 * the rule under test. Multi-tick trajectory tests use the plane provider or heightmap
 * where worldToUV is well-behaved.
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
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createCharacterControllerSystem } from "../../src/systems/characterController";
import { createForceFieldSystem } from "../../src/systems/forceField";
import { createSurfaceConstrainedVelocitySystem } from "../../src/systems/surfaceConstrainedVelocity";
import { createVolumetricConstrainedVelocitySystem } from "../../src/systems/volumetricConstrainedVelocity";
import { createTangentInputMapperSystem } from "../../src/systems/tangentInputMapper";
import { CylindricalSurfaceProvider, PlaneSurfaceProvider } from "../../src/world/parametricSurfaceProvider";
import { HeightmapSurfaceProvider, type SurfaceProvider } from "../../src/world/surfaceProvider";
import type { Heightmap } from "../../src/map/heightmap";

/**
 * Standard centripetal test setup. Provider written to `surfaceProvider.heightmap` (the
 * single SurfaceProvider slot — name is historical, accepts any provider). Character
 * pre-attached at the supplied UV with the supplied world velocity. cameraYaw chosen so
 * forward maps to +Z direction (yaw = π → FwZ = -cos π = +1).
 */
function setupOnSurface(opts: {
  provider: SurfaceProvider;
  uv: [number, number];
  velocity: [number, number, number];
  /** Camera yaw (radians); default π so forward = +Z. */
  cameraYaw?: number;
}) {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createForceFieldSystem());
  reg.registerSystem(createTangentInputMapperSystem());
  reg.registerSystem(createCharacterControllerSystem());
  reg.registerSystem(createSurfaceConstrainedVelocitySystem());
  reg.registerSystem(createVolumetricConstrainedVelocitySystem());

  const id = 1;
  const sample = opts.provider.sampleAtUV(opts.uv[0], opts.uv[1]);

  writeBuffer(reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID), (d) => {
    d.heightmap = opts.provider;
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
      desiredFacingTangent: [0, 0, -1],
    });
  });
  writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
    d.byEntity.set(id, { ...emptyInput(0), cameraYaw: opts.cameraYaw ?? Math.PI });
  });
  writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      position: [sample.position[0], sample.position[1] + 0.5, sample.position[2]],
      yaw: 0,
      scale: 1,
    });
  });
  writeBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID), (d) => {
    d.byEntity.set(id, { linear: [...opts.velocity], prevLinear: [...opts.velocity] });
  });
  writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      surfaceId: opts.provider.id,
      uv: [opts.uv[0], opts.uv[1]],
      offsetAlongNormal: 0.5,
      sample,
    });
  });

  const g = buildExecutionGraph({
    id: "centripetal-test",
    nodes: [
      "forceFieldSystem",
      "tangentInputMapperSystem",
      "characterControllerSystem",
      "surfaceConstrainedVelocitySystem",
      "volumetricConstrainedVelocitySystem",
    ],
    registry: reg,
  });
  return { reg, id, g };
}

function tick(reg: ReturnType<typeof createRegistry>, g: ReturnType<typeof buildExecutionGraph>, dt = 0.016): void {
  executeGraph(g, reg, { dt, now: 0 });
}

// Cylinder oriented along world +X, radius R; top of the log is at (0, R, 0). u=0 is
// the top (perpA=+Y direction); tangentU at u=0 is perpB=+Z, so a character pointed in
// +Z direction is running across the log toward going over it. v=0.5 is the midpoint
// along the axis.
function horizontalLog(R: number, opts: { concave?: boolean } = {}): CylindricalSurfaceProvider {
  return new CylindricalSurfaceProvider({
    id: `log-r${R}-${opts.concave ? "concave" : "convex"}`,
    axisOrigin: [0, 0, 0],
    axisDirection: [1, 0, 0],
    radius: R,
    height: 40,
    concave: opts.concave ?? false,
  });
}

// Suppress the [CC] dev console output during these tests — we assert the same
// information via ctrl.lastTransitionReason and the tests would otherwise drown stdout.
let consoleSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => { consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { consoleSpy?.mockRestore(); consoleSpy = null; });

describe("Centripetal-aware leave-surface rule", () => {
  it("slow run (v=4) over a convex cylinder R=20 does NOT centripetal-detach", () => {
    // v²/R = 16/20 = 0.8; gravity·N = 9.81. apparent_N = -9.81 - (-0.8) = -9.01 < 0.
    // Surface still pushes up; grip not needed. Centripetal rule should not fire.
    // (The controller may transition to surfaceSlide because the test pre-sets v with no
    // input, asking the controller to brake harder than grip allows — that's correct
    // controller behavior and unrelated to the centripetal rule being tested here.)
    const { reg, id, g } = setupOnSurface({
      provider: horizontalLog(20),
      uv: [0, 0.5],
      velocity: [0, 0, 4],
    });
    tick(reg, g, 0.016);
    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    expect(ctrl.lastTransitionReason).not.toContain("centripetal");
    expect(ctrl.lastTransitionReason).not.toContain("departing");
  });

  it("moderate run (v=15) over a convex cylinder R=20 does NOT centripetal-detach (within grip budget)", () => {
    // v²/R = 11.25; apparent_N = -9.81 + 11.25 = 1.44. Grip budget 5. 1.44 < 5 → no centripetal-leave.
    const { reg, id, g } = setupOnSurface({
      provider: horizontalLog(20),
      uv: [0, 0.5],
      velocity: [0, 0, 15],
    });
    tick(reg, g, 0.016);
    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    expect(ctrl.lastTransitionReason).not.toContain("centripetal");
    expect(ctrl.lastTransitionReason).not.toContain("departing");
  });

  it("fast run (v=20) over a convex cylinder R=20 detaches with reason 'centripetal'", () => {
    // v²/R = 20; apparent_N = -9.81 + 20 = 10.19 > grip 5. Surface can't pull → detach.
    const { reg, id, g } = setupOnSurface({
      provider: horizontalLog(20),
      uv: [0, 0.5],
      velocity: [0, 0, 20],
    });
    tick(reg, g, 0.016);
    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    expect(ctrl.state).toBe("airborne");
    expect(ctrl.locomotionMode).toBe("volumeConstrained");
    expect(ctrl.lastTransitionReason).toContain("centripetal");
  });

  it("very fast run (v=30) over a tighter convex cylinder R=5 detaches", () => {
    // v²/R = 900/5 = 180 m/s²; apparent_N = -9.81 + 180 = 170 ≫ grip 5 → detach.
    const { reg, id, g } = setupOnSurface({
      provider: horizontalLog(5),
      uv: [0, 0.5],
      velocity: [0, 0, 30],
    });
    tick(reg, g, 0.016);
    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    expect(ctrl.state).toBe("airborne");
    expect(ctrl.lastTransitionReason).toContain("centripetal");
  });

  it("running inside a concave cylinder at any speed never detaches from curvature alone", () => {
    // Concave inside-of-cylinder ("wall of death"). Vertical axis; character on inside
    // wall running around perimeter. Centripetal force points toward axis (+N for
    // concave). Gravity (-Y) is perpendicular to N (axis is +Y, so N is in XZ plane).
    //   aExN = 0, aCentripetalN = +v²/R (positive into surface).
    //   apparent_N = aExN - aCentripetalN = -v²/R < 0 always → never centripetal-detach.
    const verticalConcaveCyl = new CylindricalSurfaceProvider({
      id: "wall-of-death",
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 1, 0],
      radius: 10,
      height: 30,
      concave: true,
    });
    for (const v of [5, 15, 30, 50]) {
      // Character at u=0 on the inside wall (north side, facing into wall normal = -Y radial).
      // u=0 → perpA=+X (since axis=+Y), perpB=cross(+Y,+X)=+Z. radial(0)=+X. With concave=true,
      // N = -radial = -X (points toward axis from the +X-side wall).
      // tangentU(0) = perpB = +Z. Running in +Z direction at speed v along the perimeter.
      const { reg, id, g } = setupOnSurface({
        provider: verticalConcaveCyl,
        uv: [0, 0.5],
        velocity: [0, 0, v],
      });
      tick(reg, g, 0.016);
      const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
      // Should not have detached due to centripetal force pushing into surface.
      // (May transition to surfaceSlide if grip exceeded for some reason, but not to airborne via centripetal.)
      expect(ctrl.lastTransitionReason).not.toContain("centripetal");
    }
  });

  it("regular terrain with a small-radius bump: running over the apex at speed launches the character", () => {
    // Build a 40×40m heightmap with a Gaussian dome at the center: peak 2m, sigma 2m
    // (1m-tile cells, so sigma_in_cells = 2). At the apex (u=0.5, v=0.5):
    //   H_xx = H_zz = -peak/sigma² = -0.5 (1/m); H_uu = H_xx · W² = -800 (1/UV²)
    //   Centripetal accel along N for a character moving at world v in any tangent
    //   direction = N_y · H_uu · (v/W)² = 1 · -800 · v²/1600 = -v²/2.
    //   For v=8 → centripetal = -32. apparent_N = -9.81 + 32 = 22.19 > grip 5 → DETACH.
    //   For v=3 → centripetal = -4.5. apparent_N = -9.81 + 4.5 = -5.31 < 0 → no detach.
    const W = 40, D = 40, peak = 2, sigma = 2;
    const data = new Float32Array(W * D);
    for (let z = 0; z < D; z++) {
      for (let x = 0; x < W; x++) {
        const dx = x - (W - 1) * 0.5;
        const dz = z - (D - 1) * 0.5;
        data[z * W + x] = peak * Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
      }
    }
    const hm: Heightmap = { width: W, height: D, tileSize: 1, data };
    const provider = new HeightmapSurfaceProvider("terrain-bump", hm);

    // Fast run over the apex (v=8 in +X) → should launch.
    const fast = setupOnSurface({
      provider,
      uv: [0.5, 0.5],
      velocity: [8, 0, 0],
      cameraYaw: -Math.PI / 2,
    });
    tick(fast.reg, fast.g, 0.016);
    const ctrlFast = readBuffer(fast.reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(fast.id)!;
    expect(ctrlFast.state).toBe("airborne");
    expect(ctrlFast.lastTransitionReason).toContain("centripetal");

    // Slow run over the apex (v=3 in +X) → should stay attached (centripetal not enough).
    const slow = setupOnSurface({
      provider,
      uv: [0.5, 0.5],
      velocity: [3, 0, 0],
      cameraYaw: -Math.PI / 2,
    });
    tick(slow.reg, slow.g, 0.016);
    const ctrlSlow = readBuffer(slow.reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(slow.id)!;
    expect(ctrlSlow.lastTransitionReason).not.toContain("centripetal");
  });

  it("flat plane provider: zero curvature → centripetal accel = 0 → behaves like today's controller", () => {
    // Sanity check: with a flat plane (κ ≡ 0), the centripetal term is identically zero
    // and the leave rule reduces to the pure-gravity case. Standing still on flat ground
    // means apparent_N = -9.81, pullDemand = -9.81 (negative, not a real pull) → grip not
    // tested → stays attached. Same behavior as before Phase 4.
    const plane = new PlaneSurfaceProvider({
      id: "flat-test",
      origin: [-50, 0, -50],
      extentU: [100, 0, 0],
      extentV: [0, 0, 100],
    });
    const { reg, id, g } = setupOnSurface({
      provider: plane,
      uv: [0.5, 0.5],
      velocity: [0, 0, 0],
    });
    tick(reg, g, 0.016);
    const ctrl = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(id)!;
    expect(ctrl.state).toBe("surfaceRun");
  });
});
