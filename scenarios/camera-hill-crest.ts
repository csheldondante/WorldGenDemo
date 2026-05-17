/**
 * Test: character runs over a heightmap ridge — camera should NOT sign-flip.
 *
 * Pre-Phase 2/3 the camera anchored at a fixed world-Y offset behind the
 * player. As the player crested a hill the camera ended up *below* the
 * surface, looking through the slope, then snapped to the other side once
 * the player descended. The new pivot.up + parallel-transport pipeline
 * keeps the camera smoothly above the local horizon — this scenario locks
 * that behavior in as a regression baseline.
 *
 * Scene: 64×64 heightmap with a Gaussian ridge along the row axis,
 * peak 5 m, σ ≈ 6 m. Player spawns south of the ridge, holds KeyW for
 * 240 ticks (~4 s), walks up + over + down. The character physics here
 * is identical to `heightmap-hill-traverse` — the *camera* trajectory is
 * what changed. Compare camera.pos.* + camera.pitch curves between the
 * two baselines to see the smooth crest.
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildRidgeHeightmap(): Heightmap {
  const W = 64, H = 64;
  const data = new Float32Array(W * H);
  const peak = 5.0;
  const sigma = 6.0;
  const cr = (H - 1) / 2;
  for (let r = 0; r < H; r++) {
    const dr = r - cr;
    const elev = peak * Math.exp(-(dr * dr) / (2 * sigma * sigma));
    for (let c = 0; c < W; c++) data[r * W + c] = elev;
  }
  return { width: W, height: H, tileSize: 1, data };
}

export const test: BufferTest = {
  name: "camera-hill-crest",
  description:
    "64×64 heightmap with a Gaussian ridge (peak 5m, σ≈6m). Player holds KeyW for 240 " +
    "ticks (~4s), walking south-to-north over the crest. Locks in the post-Phase-2/3 " +
    "camera behavior: gravity-up pivot + parallel-transport + smoothed orbit means the " +
    "camera glides over the hill instead of dipping below the surface to look through it.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("ridge", buildRidgeHeightmap());
      seedPlayerOnSurface(reg, provider, { uv: [0.5, 0.15] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 240, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
