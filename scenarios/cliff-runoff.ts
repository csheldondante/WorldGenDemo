/**
 * Test: run forward off a heightmap terrace and become airborne.
 *
 * 64×64 heightmap with a flat plateau (y=5m) on the north half and a sharp
 * drop to y=0 on the south half. Player spawns on the plateau, holds KeyW;
 * walks south at run speed, runs off the cliff, transitions surfaceRun →
 * airborne with reason "walked off edge" (or centripetal/grip — depending
 * on the exact mechanism that fires first), arcs down under gravity, lands
 * on the lower deck.
 *
 * Catches: surface ↔ volumetric transition, landing snap, and the
 * orbit-back behavior. Any regression that breaks the airborne → landing
 * pipeline will show different terminal pos/vel here.
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildTerraceHeightmap(): Heightmap {
  const W = 64, H = 64;
  const data = new Float32Array(W * H);
  // North half (rows 0..30): elevation 5m. South half (rows 33..63): elevation 0m.
  // Rows 30..33: linear ramp from 5→0 over 3m so the drop is sharp but not
  // perfectly vertical (avoids degenerate normals).
  for (let r = 0; r < H; r++) {
    let elev: number;
    if (r <= 30) elev = 5.0;
    else if (r >= 33) elev = 0.0;
    else elev = 5.0 - (r - 30) * (5.0 / 3.0);
    for (let c = 0; c < W; c++) {
      data[r * W + c] = elev;
    }
  }
  return { width: W, height: H, tileSize: 1, data };
}

export const test: BufferTest = {
  name: "cliff-runoff",
  description:
    "64×64 heightmap with a 5m elevated plateau (north) and a 0m deck (south) joined by " +
    "a sharp ~60° ramp. Player spawns on the plateau at uv (0.5, 0.2), holds KeyW for " +
    "180 ticks (~3s) walking south. Crosses the edge, goes airborne, falls + lands. " +
    "Catches surface↔volumetric transition + landing snap regressions.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("terrace", buildTerraceHeightmap());
      seedPlayerOnSurface(reg, provider, { uv: [0.5, 0.2] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 180, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
