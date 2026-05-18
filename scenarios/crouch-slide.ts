/**
 * Test: character runs up to speed on a flat plane, then presses crouch and
 * transitions to surfaceSlide. Locks the manual slide trigger.
 *
 * Simulated input: hold KeyW for the first 120 ticks (~2s, builds speed
 * past slideMinSpeed = 2 m/s); then add Ctrl on top for the rest, keeping
 * crouch held so the slide doesn't recover. Final state should be
 * surfaceSlide with reason starting with "crouch slide".
 */
import type { BufferTest } from "../src/app/bufferTest";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

const KEYS_WALK = new Set(["KeyW"]);
const KEYS_WALK_CROUCH = new Set(["KeyW", "ControlLeft"]);

export const test: BufferTest = {
  name: "crouch-slide",
  description:
    "200×200m flat plane. Player holds KeyW for 120 ticks to build speed, then " +
    "adds ControlLeft (crouch) for another 180 ticks. Crouch press triggers " +
    "manual slide; held crouch prevents recovery so final state is surfaceSlide.",
  inputSystem: createSimulatedInputSystem((tick) => ({
    keys: tick < 120 ? KEYS_WALK : KEYS_WALK_CROUCH,
    pointerLocked: true,
  })),
  input: {
    kind: "seed",
    fn: (reg) => {
      const PATCH = 200;
      const provider = new PlaneSurfaceProvider({
        id: "crouch-plane",
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
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 300, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 24, axisGizmo: true },
};
