/**
 * Test: mouse-look input → camera yaw + pitch evolves correctly.
 *
 * Drives mouseDx/mouseDy on every tick via a simulated generator so the full
 * input pipeline (InputSystem → InputMapperSystem → CameraFollowSystem) runs
 * unchanged. After 120 ticks the camera should have:
 *   - rotated yaw by `total_mouseDx · MOUSE_SENS` (negative — mouse-right
 *     decreases yaw by inputMapper convention).
 *   - rotated pitch by `−total_mouseDy · MOUSE_SENS` (negated likewise).
 *
 * Validates the input → camera contract end-to-end.
 *
 * Scene setup: a stationary player on a flat plane so the camera has
 * something to track. Player doesn't hold any keys; input only drives the
 * mouse delta. The plane + axis gizmo + player sphere give the user a
 * visual reference to see camera rotation during playback.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import {
  createSimulatedInputSystem,
  type SimulatedInputGenerator,
} from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

/** Constant mouse delta each tick: +2px right, +1px down. */
const mouseLookGenerator: SimulatedInputGenerator = () => ({
  pointerLocked: true,
  mouseDx: 2,
  mouseDy: 1,
});

export const test: BufferTest = {
  name: "camera-look-input",
  description:
    "Stationary player on a 50×50m plane. 120 ticks of constant mouse delta (+2px right, " +
    "+1px down per tick) into the real Input → InputMapper → CameraFollow chain. " +
    "Verifies look-delta accumulates into cam.yaw/cam.pitch correctly. Visual reference: " +
    "wireframe plane + axis gizmo + the stationary player sphere; the camera should orbit " +
    "around them.",
  inputSystem: createSimulatedInputSystem(mouseLookGenerator),
  input: {
    kind: "seed",
    fn: (reg) => {
      // Smaller plane than flat-plane-forward — character is stationary so we
      // don't need 200m of travel room; a 50m square keeps the wireframe
      // dense enough to read at the camera distance.
      const PATCH = 50;
      const provider = new PlaneSurfaceProvider({
        id: "flat-50",
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
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 120, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 24, axisGizmo: true },
};
