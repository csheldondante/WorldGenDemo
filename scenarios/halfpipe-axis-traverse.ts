/**
 * Test: rock across the bottom of a half-pipe.
 *
 * Concave cylinder (axis +X, R=8m, H=30m). Spawn at uv (0.5, 0.5) — the
 * bottom of the half-pipe. With cameraYaw=π, camera-forward is +Z. At
 * u=0.5 the surface tangents are tangentU = -perpB = -Z (across the curve)
 * and tangentV = axisDir = +X (along the axis). The forward thrust (+Z)
 * projects fully onto -tangentU, so the character pushes UP one side of
 * the half-pipe, slides back down, and oscillates across the U-curve.
 *
 * This is the half-pipe "rocking" test, not an along-axis traversal — the
 * along-axis direction is +X (perpendicular to camera-forward) and isn't
 * driven by KeyW with this camera yaw. A proper "skate along the trough"
 * test would set cameraYaw=π/2 or 3π/2 so forward is ±X.
 *
 * Tests: concave surface attachment, normal direction sign, gravity-driven
 * oscillation across a U-curve, surfaceRun ↔ surfaceSlide thresholds as
 * the character climbs the side and loses momentum.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { CylindricalSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

export const test: BufferTest = {
  name: "halfpipe-axis-traverse",
  description:
    "Concave horizontal cylinder (axis +X, R=8m, H=30m). Player spawns at uv (0.5, 0.5) " +
    "— the bottom — holds KeyW for 180 ticks (~3s). Forward thrust at cameraYaw=π drives " +
    "across the U-curve (perpendicular to the axis), so the character rocks up one side " +
    "and back. Tests concave attachment + gravity-driven oscillation. (The name " +
    "'axis-traverse' is a misnomer — kept for baseline stability; rename when we add " +
    "real-input recording for actual along-axis half-pipe pumping.)",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new CylindricalSurfaceProvider({
        id: "halfpipe",
        axisOrigin: [0, 0, 0],
        axisDirection: [1, 0, 0],
        radius: 8,
        height: 30,
        concave: true,
      });
      seedPlayerOnSurface(reg, provider, { uv: [0.5, 0.5] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 180, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
