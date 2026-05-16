/**
 * Test: walk uphill on a convex log toward the top.
 *
 * Convex cylinder (horizontal axis +X, radius 8m). Spawn at uv (0.15, 0.5)
 * — already on the side of the log, slope ≈ 54° from horizontal. With
 * cameraYaw=0, camera-forward is -Z; projected onto the tangent plane it
 * becomes -tangentU, which on a convex cylinder points toward smaller u
 * (toward the top). So KeyW drives the character UPHILL.
 *
 * Spawning at u=0 (the flat top) just bounces the character around the
 * perimeter — there's no defined downhill, and the centripetal demand from
 * walking around the curve launches them off. Spawning at u=0.15 gives a
 * real slope to climb and tests grip + slope-run threshold on a smooth
 * curve.
 *
 * Tests: surface-frame physics on a curved surface, uphill climb with
 * slope above the slopeRunMaxRad threshold (expected: progresses some
 * distance up, slope steepens approaching the top, possible slide-back
 * if grip insufficient).
 */
import type { BufferTest } from "../src/app/bufferTest";
import { CylindricalSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

export const test: BufferTest = {
  name: "cylinder-slope-climb",
  description:
    "Convex horizontal cylinder (axis +X, R=8m). Player spawns on the side at uv (0.15, " +
    "0.5) — slope ≈54° — with cameraYaw=0 so KeyW drives uphill toward the top. Holds " +
    "KeyW for 180 ticks (~3s); should make some progress up the curve then slip back as " +
    "slope steepens. Tests surface-frame physics + grip threshold on a smooth curve.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new CylindricalSurfaceProvider({
        id: "log-slope",
        axisOrigin: [0, 0, 0],
        axisDirection: [1, 0, 0],
        radius: 8,
        height: 30,
        concave: false,
      });
      seedPlayerOnSurface(reg, provider, { uv: [0.15, 0.5], cameraYaw: 0 });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 180, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
