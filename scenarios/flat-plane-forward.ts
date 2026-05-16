/**
 * Test: hold forward on a 200×200m flat plane for ~3 seconds.
 *
 * Drives the REAL bootstrap with `holdKeysGenerator(["KeyW"])`. The full real
 * input pipeline runs (inputSystem → inputMapper → characterInput →
 * tangentInputMapper → characterController → surfaceConstrainedVelocity →
 * volumetricConstrainedVelocity → surfaceConstraint → cameraPivot → cameraOrbit → body
 * lean → chain dynamics → foot planner → foot IK → skeleton FK). Render
 * excluded from the test step (headless).
 *
 * Baseline at `__baselines__/flat-plane-forward.json` locks every gameplay
 * buffer's final state under the default 1e-6 absolute tolerance.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

export const test: BufferTest = {
  name: "flat-plane-forward",
  description:
    "200×200m flat plane. Player holds KeyW for 180 ticks (~3s). Verifies convergent " +
    "forward speed with no lateral or vertical drift across all gameplay buffers.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const PATCH = 200;
      const provider = new PlaneSurfaceProvider({
        id: "flat",
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
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 180, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 16, axisGizmo: true },
};
