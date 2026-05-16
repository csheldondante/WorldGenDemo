/**
 * Test: hold forward + strafe → character traces an arc.
 *
 * Flat plane. Simulated input holds KeyW (forward) AND KeyD (strafe right)
 * at constant magnitude for 240 ticks (~4s). With both axes equal, the
 * world-space move vector is at 45° to forward; the character's body yaw
 * tracks the move direction (`characterOrientationSystem` policy: target =
 * cam.yaw − atan2(moveX, moveY)), so over time the character traces a slow
 * arc as the body yaw catches up to the latched target.
 *
 * Tests: directional changes, body yaw second-order controller settling,
 * camera follow tracking when the player isn't moving in a straight line.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

export const test: BufferTest = {
  name: "circle-running",
  description:
    "200×200m flat plane. Player holds KeyW + KeyD for 240 ticks (~4s). With both move " +
    "axes engaged the world-direction is diagonal; body yaw chases the move direction so " +
    "the character traces an arc rather than a straight line. Tests directional changes " +
    "and the body-yaw controller's second-order settling under constant input.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW", "KeyD"])),
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
