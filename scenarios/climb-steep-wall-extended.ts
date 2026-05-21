/**
 * Diagnostic variant of `climb-steep-wall` — same scene, 900 ticks (15 s)
 * instead of 300. The standard scenario stops while the body is still
 * mid-climb (around posY ≈ 4 m of the 10 m peak); user reported 2026-05-21
 * that the climb "still looks choppy and bad" and the choppiness may be
 * at the top transition (climb → surfaceRun when body crests the mesa)
 * which the 300-tick scenario doesn't reach.
 *
 * Identical seed + heightmap + input to climb-steep-wall — extend ticks
 * only. characterControllerDebug enabled so the per-tick controller state
 * is captured into the baseline JSON as a regression artifact.
 *
 * Framework-compliant per docs/unit_tests.md (NOT a hand-rolled diagnostic
 * script).
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildClimbWallHeightmap(): Heightmap {
  // Mirror climb-steep-wall's mesa: peak=10, topRadius=5, slopeWidth=2.
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
  name: "climb-steep-wall-extended",
  description:
    "Same 60×60 mesa as climb-steep-wall (peak=10m, ~83° walls + 5m flat top), " +
    "extended to 900 ticks (~15s) so the body actually reaches the flat top and " +
    "transitions climb → surfaceRun. Diagnostic for the top-of-climb chop.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("climbWall", buildClimbWallHeightmap());
      seedPlayerOnSurface(reg, provider, { uv: [0.2, 0.5], cameraYaw: -Math.PI / 2 });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 900, dt: 1 / 60 },
  ],
  enableDebugBuffers: ["characterControllerDebug"],
  output: { snapshot: [...GAMEPLAY_OUTPUT_BUFFERS, "characterControllerDebug"] },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 60, axisGizmo: true },
};
