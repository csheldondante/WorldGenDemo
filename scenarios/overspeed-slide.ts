/**
 * Test: character running down a long steep slope picks up speed past the
 * profile's kinematic top-speed threshold and trips into surfaceSlide.
 *
 * The heightmap is a long ~25° downhill ramp — steep enough that
 * gravity-along-tangent shifts the forward-accel curve so the sustainable
 * speed is above `profile.topSpeedSlipThreshold` (default 12 m/s), but
 * not so steep that we hit the "stalled-on-slope" rule. The character
 * holds KeyW; gravity does the rest, gaining speed each tick until the
 * overspeed rule fires.
 *
 * Validates the kinematic-overspeed slip criterion: limbs can't cycle
 * faster than topSpeedSlipThreshold, so when momentum (here from
 * gravity) pushes them above it, they trip. Wheeled archetypes will
 * disable this by setting topSpeedSlipThreshold = Infinity.
 */
import type { BufferTest } from "../src/app/bufferTest";
import type { Heightmap } from "../src/map/heightmap";
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

function buildRampHeightmap(): Heightmap {
  const W = 64, H = 128;
  const data = new Float32Array(W * H);
  // North end (low r) at high elevation, south end (high r) at low. Drop=120 over
  // 128 cells ≈ 43° downhill. Steep enough that gravity-along-tangent pushes the
  // sustainable speed above topSpeedSlipThreshold (9 m/s with default profile),
  // shallow enough to stay below slopeRunMaxRad (52°) so we don't hit the
  // stalled-on-slope trigger first.
  for (let r = 0; r < H; r++) {
    const elev = 120.0 * (1 - r / (H - 1));
    for (let c = 0; c < W; c++) data[r * W + c] = elev;
  }
  return { width: W, height: H, tileSize: 1, data };
}

export const test: BufferTest = {
  name: "overspeed-slide",
  description:
    "64×128 heightmap configured as a ~25° downhill ramp. Player holds KeyW for 360 " +
    "ticks (~6s) running south (downhill); gravity-along-tangent shifts the natural " +
    "top-speed up past topSpeedSlipThreshold (12 m/s) and the character trips into " +
    "surfaceSlide. Locks the kinematic-overspeed slip rule.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new HeightmapSurfaceProvider("ramp", buildRampHeightmap());
      // Spawn near the top of the ramp; cameraYaw=π → walk +Z (south = down).
      seedPlayerOnSurface(reg, provider, { uv: [0.5, 0.1] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 360, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
