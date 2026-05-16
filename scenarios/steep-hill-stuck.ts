/**
 * Test: walk into a hill steep enough to stop the player.
 *
 * 64×64 heightmap with a steep central pyramid (peak 18m, σ≈4m). The slope
 * at mid-height exceeds slopeRunMaxRad — player walks up, hits the steep
 * section, transitions to surfaceSlide, slides back down.
 *
 * Catches regressions in the grip/slope-too-steep detection: if the
 * threshold drifts, the player either climbs an impossible slope (rendering
 * is broken) or gets stuck on a normal hill.
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildSteepHillHeightmap(): Heightmap {
  const W = 64, H = 64;
  const data = new Float32Array(W * H);
  const peakCol = 32, peakRow = 32, peakElev = 18.0, sigma = 4.0;
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const dx = c - peakCol;
      const dz = r - peakRow;
      data[r * W + c] = peakElev * Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
    }
  }
  return { width: W, height: H, tileSize: 1, data };
}

export const test: BufferTest = {
  name: "steep-hill-stuck",
  description:
    "64×64 heightmap with a sharp peak (18m, σ≈4m). Player holds KeyW for 240 ticks (~4s); " +
    "expected to walk into the steep section, transition surfaceRun → surfaceSlide, slide " +
    "back, oscillate between sliding and running. Catches grip/slope threshold drift.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("steepHill", buildSteepHillHeightmap());
      // Spawn at uv.v=0.2 (north of center). Player walks south (+Z at yaw=π)
      // toward the peak at uv.v=0.5.
      seedPlayerOnSurface(reg, provider, { uv: [0.5, 0.2] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 240, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
