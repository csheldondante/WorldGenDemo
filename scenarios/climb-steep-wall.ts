/**
 * Test: walk into a near-vertical wall and grip it via climb state.
 *
 * 60×60 heightmap with a tall, sharply-walled mesa (peak 10m, topRadius 5m,
 * slopeWidth 2m → ~83° walls). Same shape as `public/maps/gym-climb-wall/`.
 * Player holds KeyW for ~5s; expected sequence:
 *
 *   surfaceRun → (decelerates on steep wall) → climb (grab on steep face)
 *
 * After the grip-budget fix (2026-05-18) the body should pin to the wall and
 * walk up at climb's vMax (~2 m/s), then transition climb → surfaceRun on
 * reaching the flat top.
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildClimbWallHeightmap(): Heightmap {
  // Mirror public/maps/gym-climb-wall/scene.json shape — same parametric mesa.
  const W = 60, H = 60;
  const tileSize = 1;
  const peak = 10, topRadius = 5, slopeWidth = 2;
  const data = new Float32Array(W * H);
  const cx = (W - 1) * 0.5;
  const cy = (H - 1) * 0.5;
  const topR = topRadius / tileSize;
  const slopeW = slopeWidth / tileSize;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const dx = i - cx;
      const dz = j - cy;
      const r = Math.hypot(dx, dz);
      let h: number;
      if (r <= topR) h = peak;
      else if (r >= topR + slopeW) h = 0;
      else {
        const t = (r - topR) / slopeW;
        h = peak * 0.5 * (1 + Math.cos(Math.PI * t));
      }
      data[j * W + i] = h;
    }
  }
  return { width: W, height: H, tileSize, data };
}

export const test: BufferTest = {
  name: "climb-steep-wall",
  description:
    "60×60 heightmap with a tall narrow mesa (~83° walls + 5m flat top). Player " +
    "holds KeyW for 300 ticks (~5s); expected: walk up to the wall, decelerate, " +
    "transition surfaceRun → climb (grab), grip the wall, walk up at climb vMax, " +
    "transition climb → surfaceRun at the flat top.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("climbWall", buildClimbWallHeightmap());
      // Spawn at uv (0.2, 0.5) — west of center, on flat ground. Player walks
      // east (-X at cameraYaw=Math.PI; KeyW maps to camera-forward).
      seedPlayerOnSurface(reg, provider, { uv: [0.2, 0.5], cameraYaw: -Math.PI / 2 });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 300, dt: 1 / 60 },
  ],
  // Enable per-tick diagnostic capture for the surface-frame solver and include the
  // resulting buffer in the snapshot output. The history array on
  // characterControllerDebug.byEntity.<id> contains a row per tick with gripBudget,
  // aSurfaceN, aCentripetalN, applied tangent accels, etc. — every internal quantity
  // is comparable against baseline via the same comparator that handles regular
  // buffers. This is the principled way to diagnose lurches or any per-tick anomaly.
  enableDebugBuffers: ["characterControllerDebug", "surfaceConstrainedVelocityDebug"],
  output: { snapshot: [...GAMEPLAY_OUTPUT_BUFFERS, "characterControllerDebug", "surfaceConstrainedVelocityDebug"] },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 60, axisGizmo: true },
};
