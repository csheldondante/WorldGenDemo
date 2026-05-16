/**
 * Test: walk along the bottom of a half-pipe (concave horizontal cylinder).
 *
 * Concave cylinder (axis +X, R=8m, H=30m). On a concave cylinder the player
 * stands INSIDE — the normal points toward the axis. Spawn at uv (0.5, 0.5)
 * — radial(0.5) = -perpA = -Y, normal flips to +Y for concave → surface
 * position = (15, -8, 0), player above at world Y = -8 + radius. Forward
 * (+Z at cameraYaw=π) carries them along the axis direction NO — wait,
 * tangentAround(0.5) at the bottom is -perpB·sin(π) + perpA·... hmm.
 *
 * Actually for axis=+X, perpA=+Y, perpB=+Z. radial(u=0.5) = -perpA = -Y, so
 * sample.position = (15, -8, 0). Normal (concave) = -radial = +Y. tangentU
 * at u=0.5 = -sin(π)·perpA + cos(π)·perpB = -perpB = -Z. tangentV = +X.
 *
 * So at the bottom of the half-pipe, forward = +Z (camera fwd) projected
 * onto the tangent plane (normal +Y): Ft = (0, 0, 1). Walking forward
 * carries the player ALONG THE AXIS… no wait, tangentU is -Z and tangentV
 * is +X. The player's forward thrust projected onto the tangent plane is
 * (0,0,1) which is in the -tangentU direction → player walks against u
 * direction, which means up the OTHER side of the half-pipe.
 *
 * This is a "simulated input is approximate" scenario — the player just
 * walks forward; the actual path traces the curved interior. Once you have
 * Tab-override real input, replace the input with a recorded session for
 * proper half-pipe pumping.
 *
 * Tests: concave surface attachment, normal direction sign, walking through
 * the bottom + up one side. Placeholder coverage until real-input
 * recording is wired.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { CylindricalSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

export const test: BufferTest = {
  name: "halfpipe-axis-traverse",
  description:
    "Concave horizontal cylinder (axis +X, R=8m, H=30m). Player spawns at uv (0.5, 0.5) " +
    "— the bottom of the half-pipe — holds KeyW for 180 ticks (~3s). Walks the curved " +
    "interior. PLACEHOLDER simulated input; the proper half-pipe pump-and-slide test " +
    "should use recorded real input via the upcoming Tab-override.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new CylindricalSurfaceProvider({
        id: "halfpipe",
        axisOrigin: [0, 0, 0],
        axisDirection: [1, 0, 0],
        radius: 8,
        height: 30,
        concave: true,
      });
      seedPlayerOnSurface(reg, provider, { uv: [0.5, 0.5] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 180, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
