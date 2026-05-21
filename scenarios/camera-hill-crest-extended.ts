/**
 * Diagnostic variant of `camera-hill-crest` — same Gaussian ridge + seed,
 * but runs for 600 ticks (10 s) instead of 240. Past tick 240 the player
 * has crossed the ridge and is on the descent; past ~tick 273 the body
 * exceeds vMax·1.1 and enters surfaceSlide; the descent + flat-ground
 * segments after that are what the user identified 2026-05-21 as having a
 * "slip that doesn't end" bug — body decelerates much more slowly than the
 * forwardAccel curve at v > vMax would predict.
 *
 * `characterControllerDebug` is enabled so every per-tick value the
 * surface-frame solver computes (aReqF, aFEff, fwdMax, backMax, fwdCeil,
 * gripBudget, vN, etc.) is captured into the `history` array on the
 * snapshot. The baseline locks in current behavior; future code changes
 * (e.g. capping vDes at the unshifted vMax instead of the shifted
 * x-intercept) will diff against the captured history and surface in
 * vitest.
 *
 * This is the framework-compliant alternative to the hand-rolled
 * `scripts/extendedScenario.ts` that was deleted 2026-05-21 — see
 * `docs/unit_tests.md` for why parallel per-tick trace scripts are
 * forbidden.
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildRidgeHeightmap(): Heightmap {
  // Identical to camera-hill-crest's ridge so the trajectory is comparable
  // between scenarios in the same scene.
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
  name: "camera-hill-crest-extended",
  description:
    "Same Gaussian ridge as camera-hill-crest (peak 5m, σ≈6m), 600 ticks (10s) " +
    "instead of 240. Diagnostic for surfaceSlide behavior on the descent + flat-" +
    "ground segments past tick ~273 where the body enters slide via over-speed. " +
    "characterControllerDebug captured for per-tick visibility into the controller's " +
    "force computation.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("ridge", buildRidgeHeightmap());
      seedPlayerOnSurface(reg, provider, { uv: [0.5, 0.05] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 600, dt: 1 / 60 },
  ],
  enableDebugBuffers: ["characterControllerDebug"],
  output: { snapshot: [...GAMEPLAY_OUTPUT_BUFFERS, "characterControllerDebug"] },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
