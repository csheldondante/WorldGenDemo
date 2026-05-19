/**
 * Diagnostic test: exaggerated-height variant of climb-steep-wall to make any
 * UV-stretch-induced lurch as visually obvious as possible.
 *
 * Same mesa shape as climb-steep-wall but peak=50 (5×) — slope walls are
 * effectively vertical (~88°). Each heightmap tile the body crosses on the
 * slope band represents ~5× the world Y delta compared to the standard climb-
 * steep-wall scenario, so any per-tile-crossing discontinuity in the surface-
 * frame integrator should be 5× more visible here. If the climb-steep-wall
 * stutter is rooted in the UV-vs-world-distance mismatch when |∂P/∂u| changes
 * across tiles, this scene exposes it dramatically.
 *
 * Used during the 2026-05-19 bisect of the climb-wall lurch — to isolate
 * whether the choppy visual is from FSM/transition code, friction wiring,
 * surface-provider smoothing, or the UV integration step.
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildClimbTallHeightmap(): Heightmap {
  // Mirror public/maps/gym-climb-tall/scene.json shape — 5× peak vs climb-steep-wall.
  const W = 60, H = 60;
  const tileSize = 1;
  const peak = 50, topRadius = 5, slopeWidth = 2;
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
  name: "climb-tall-wall",
  description:
    "60×60 heightmap with a 5×-exaggerated mesa (peak=50, slopeWidth=2 → ~88° walls). " +
    "Same shape as climb-steep-wall but tile crossings on the slope band cover 5× the " +
    "world-Y delta, so any per-tile-crossing discontinuity in the surface-frame " +
    "integrator is 5× more visible. Diagnostic only — used to bisect the climb-wall " +
    "lurch and confirm whether the cause is UV-stretch-related.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("climbTall", buildClimbTallHeightmap());
      seedPlayerOnSurface(reg, provider, { uv: [0.2, 0.5], cameraYaw: -Math.PI / 2 });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 300, dt: 1 / 60 },
  ],
  enableDebugBuffers: ["characterControllerDebug"],
  output: { snapshot: [...GAMEPLAY_OUTPUT_BUFFERS, "characterControllerDebug"] },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 60, axisGizmo: true },
};
