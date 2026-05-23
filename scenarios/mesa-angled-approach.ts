/**
 * Diagnostic scenario for off-axis mesa approach (2026-05-22).
 *
 * User report: when running at an angle (not perfectly radially) toward
 * a steep mesa, the character "kicks all over the place". They expect
 * the body to stay in the camera-Z + Y plane under forward input, with
 * lateral motion only from gravity exceeding lateral grip.
 *
 * Setup: same mesa as climb-steep-wall (peak=10, topRadius=5, slopeWidth=2),
 * but the body is spawned OFF-axis with cameraYaw set so forward points at
 * the mesa diagonally (= ~45° to the radial direction). Body holds forward.
 *
 * Expected trajectory under user's invariant: body's XZ should stay on a
 * line in the camera-forward horizontal direction, until/unless lateral
 * surface forces exceed lateral grip. Deviations from this line are the
 * "kicks" being diagnosed.
 *
 * 300 ticks (= 5s) — long enough for the body to reach the slope, climb
 * partway, and reveal any lateral artifacts on the way.
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildClimbMesaHeightmap(): Heightmap {
  // Identical to climb-steep-wall: 60x60 grid, peak=10 mesa with cos slope.
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
  name: "mesa-angled-approach",
  description:
    "Body runs at 45° (= off-axis) toward the climb-steep-wall mesa. " +
    "Tests trajectory stays in camera-forward + world-up plane vs. lateral kicks " +
    "observed during off-axis approaches.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("climbMesa", buildClimbMesaHeightmap());
      // UV (0.15, 0.35) → world ~(-21, ?, -9) (offset both axes from center).
      // cameraYaw oriented so KeyW (forward) points roughly toward mesa center (0, 0).
      // For body at (-21, *, -9), direction to center = (21, 0, 9). atan2(21, 9) ≈ 1.166 rad.
      // cameraYaw uses standard convention where 0 = -Z forward; need to set so
      // forward vector matches body's intended motion direction.
      seedPlayerOnSurface(reg, provider, {
        uv: [0.15, 0.35],
        // Camera yaw convention: yaw=0 → -Z forward, increases CCW around +Y.
        // Body at (-21, *, -9). Mesa center at (0, 0). Forward should be ≈
        // (+21, 0, +9) normalized. atan2(-21, -9)-π gives yaw such that
        // forward = (sin(-yaw), 0, -cos(-yaw)) matches the heading.
        cameraYaw: Math.atan2(21, 9) + Math.PI,
      });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 300, dt: 1 / 60 },
  ],
  enableDebugBuffers: ["characterControllerDebug", "surfaceConstrainedVelocityDebug"],
  output: { snapshot: [...GAMEPLAY_OUTPUT_BUFFERS, "characterControllerDebug", "surfaceConstrainedVelocityDebug"] },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 60, axisGizmo: true },
};
