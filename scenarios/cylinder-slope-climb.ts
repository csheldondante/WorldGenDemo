/**
 * Test: walk up a curved slope (quarter-cylinder).
 *
 * Convex cylinder (horizontal axis +X, radius 8m, height 30m). Player spawns
 * at uv (0, 0.5) — the "top" of the log per `basisPerpendicular(+X)` →
 * perpA = +Y, so radial(0) = +Y and the spawn world position is (15, R+r, 0)
 * = directly above the axis at v=0.5. Walking forward (KeyW at cameraYaw=π
 * → +Z) carries the character around the perimeter.
 *
 * Because perpB = cross(+X, +Y) = +Z, tangentAround(0) at the top = +Z.
 * So holding forward walks the character along the curving surface — the
 * "slope" gets steeper as u grows. Around u=0.15 the slope reaches
 * slopeRunMaxRad and the character transitions to surfaceSlide, then slips
 * back down toward the top.
 *
 * Tests: surface-frame physics on a curved surface, surfaceRun ↔
 * surfaceSlide threshold on a smooth curve.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { CylindricalSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

export const test: BufferTest = {
  name: "cylinder-slope-climb",
  description:
    "Convex horizontal cylinder (axis +X, R=8m). Player spawns on top at uv (0, 0.5), " +
    "holds KeyW for 180 ticks (~3s). Walks around the perimeter onto the increasingly " +
    "steep slope; transitions to surfaceSlide around u≈0.15 where slope exceeds " +
    "slopeRunMaxRad; should oscillate slide/run near the threshold. Tests surface-frame " +
    "physics on a smooth curve.",
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
      seedPlayerOnSurface(reg, provider, { uv: [0, 0.5] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 180, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
