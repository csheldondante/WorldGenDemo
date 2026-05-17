/**
 * Test: hold mouse-UP for an extended period — pitch should settle inside
 * the soft cushion, never touch the hard floor.
 *
 * The user pushes the mouse UP (screen-up) at a steady rate. inputMapper
 * yields lookDelta.pitch > 0 each tick; CameraOrbit applies it as
 * `target.pitch -= lookDelta.pitch`, so target.pitch decreases. Once it
 * drops below `pitchSoftMin` (0.18 rad), the damped cushion kicks in: each
 * tick the cushion pulls target.pitch back toward pitchSoftMin at rate
 * `pitchCushionStiffness`. With constant mouse pressure the system
 * settles at an equilibrium pitch somewhere between `pitchSoftMin` and
 * `pitchMin` — not at the hard floor.
 *
 * Baseline locks in:
 *   - target.pitch resting between pitchMin and pitchSoftMin (in cushion)
 *   - rendered cam.pos NEVER below the local horizon (no sign-flip)
 *   - rendered cam.pitch consistent with that pos
 *
 * Sign reminder (post Phase 2): the simulated input here is `mouseDy = -8`
 * (mouse moving UP on screen) so that lookDelta.pitch > 0 and target.pitch
 * goes DOWN. With the legacy sign convention this would have RAISED the
 * camera; in the new third-person convention it lowers it toward the
 * cushion.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

const NO_KEYS = new Set<string>();

export const test: BufferTest = {
  name: "camera-stare-down",
  description:
    "Stationary player on a 50×50m flat plane. Simulated input pushes mouse UP (mouseDy " +
    "= -8 px/tick) for 240 ticks (~4s), driving target.pitch down toward pitchMin. " +
    "Locks in the damped-cushion settle: pitch comes to rest inside [pitchMin, pitchSoftMin], " +
    "never crosses the hard floor, never sign-flips.",
  inputSystem: createSimulatedInputSystem(() => ({
    keys: NO_KEYS,
    mouseDx: 0,
    mouseDy: -8,
    pointerLocked: true,
  })),
  input: {
    kind: "seed",
    fn: (reg) => {
      const PATCH = 50;
      const provider = new PlaneSurfaceProvider({
        id: "stare-plane",
        origin: [-PATCH / 2, 0, PATCH / 2],
        extentU: [PATCH, 0, 0],
        extentV: [0, 0, -PATCH],
        friction: 1,
        normalInMax: 800,
        normalOutMax: 200,
      });
      seedPlayerOnSurface(reg, provider, { uv: [0.5, 0.5] });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 240, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 24, axisGizmo: true },
};
