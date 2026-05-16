/**
 * Test: hold forward while the camera rotates → character runs in a circle.
 *
 * Flat plane. Simulated input holds KeyW continuously AND injects a constant
 * mouse-Δx every tick. The mouse delta yaws the camera at a fixed angular
 * rate; the character's move direction is camera-relative, so as the camera
 * sweeps, the forward thrust direction sweeps with it. The character's body
 * yaw chases the moving target — net effect: the player runs a closed (or
 * near-closed) loop in world space.
 *
 * MOUSE_SENS = 0.0022 rad/px (inputMapper). At dt=1/60 and mouseDx=12 px/tick
 * → yaw rate ≈ 12·0.0022·60 = 1.58 rad/s, period ≈ 4 s. Over 240 ticks
 * (4 s) the camera completes one full revolution and the player traces an
 * approximately closed circle whose radius depends on player speed and yaw rate.
 *
 * Tests: directional changes under continuous yaw, body-yaw controller
 * second-order settling under a rotating target, camera-relative input
 * transformation, and the diagonal-magnitude normalization (forward-only,
 * so |move|=1 throughout — a regression in normalization would not show here
 * but would break a future diagonal-circle variant).
 */
import type { BufferTest } from "../src/app/bufferTest";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

const FORWARD_KEYS = new Set(["KeyW"]);

export const test: BufferTest = {
  name: "circle-running",
  description:
    "200×200m flat plane. Player holds KeyW with a constant mouse-Δx (12 px/tick) for " +
    "240 ticks (~4s). Camera yaws at ~1.58 rad/s; player forward thrust rotates with it, " +
    "tracing one full circle. Tests camera-relative input transformation and body-yaw " +
    "controller under a rotating target.",
  inputSystem: createSimulatedInputSystem(() => ({
    keys: FORWARD_KEYS,
    mouseDx: 12,
    pointerLocked: true,
  })),
  input: {
    kind: "seed",
    fn: (reg) => {
      const PATCH = 200;
      const provider = new PlaneSurfaceProvider({
        id: "flat-circle",
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
