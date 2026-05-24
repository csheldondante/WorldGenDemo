/**
 * Integration scenario for bindingSwapSystem + applyControllerBinding +
 * the live-character profile-buffer read path. Covers:
 *
 *   - bindingSwapSystem drains a BindingRequested event
 *   - applyControllerBinding writes the binding's profile into
 *     CharacterControllerProfileBuffer.byId.set("default", ...)
 *   - tangentInputMapperSystem picks up the new curves and produces
 *     a different vDesF on the next tick
 *   - the character physics integrates with the new target speed
 *
 * Two phases:
 *   1. Hold forward 60 ticks under biped:standard (= default).
 *   2. Emit BindingRequested → biped:agile via a `mutate` step,
 *      then hold forward another 60 ticks. The agile profile has
 *      1.6× forwardAccel.vMax, so the character should accelerate
 *      to a higher steady-state.
 *
 * Baseline locks the trajectory across the swap. Catches regressions
 * in bindingSwap routing or the profile installation contract.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { writeBuffer } from "../src/runtime/buffer";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "../src/runtime/stateMachine";
import { applyControllerBinding } from "../src/app/applyControllerBinding";
import { createBindingSwapSystem } from "../src/runtime/bindingSwapSystem";
import { materializeBindings } from "../src/app/characterBindings";
import { registerBipedDefaultBinding } from "../src/app/bipedBinding";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

const HEADLESS_WITH_BINDING_SWAP = [
  ...HEADLESS_GAMEPLAY_SYSTEMS,
  // BindingSwapSystem ticks to drain BindingRequested events the
  // scenario emits between phases.
  "bindingSwapSystem",
];

export const test: BufferTest = {
  name: "binding-swap-propagation",
  description:
    "Hold KeyW on a flat plane for 60 ticks under biped:standard, swap to " +
    "biped:agile via BindingRequested event + mutate step, hold another 60 " +
    "ticks. Verifies bindingSwap + profile install + downstream read all " +
    "wire up (= the live character should reach a higher steady-state speed " +
    "under agile).",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      // Pre-register the biped module set + binding catalog the
      // swap targets. The scenario harness's bootstrap does this in
      // browser/test setup paths but seed runs at scenario init.
      const { binding: bipedDefault, moduleRegistry } = registerBipedDefaultBinding(reg);
      void moduleRegistry;
      const catalog = materializeBindings(bipedDefault);
      // Re-register the binding-swap system with the materialized
      // catalog + an applyBinding callback. bootstrap registered one
      // with an EMPTY catalog (no characterBindings flow ran). We
      // replace it (= reg.replaceSystem) so the in-scenario
      // BindingRequested event is actually routed.
      reg.replaceSystem(createBindingSwapSystem({
        catalog,
        apply: (b) => applyControllerBinding(reg, b),
        writeBufferIds: ["characterControllerProfile"],
        runsBefore: [
          "bodyLeanSystem", "characterControllerSystem",
          "characterOrientationSystem", "footIkSystem", "footPlannerSystem",
          "forceFieldSystem", "surfaceConstrainedVelocitySystem",
          "surfaceConstraintSystem", "tangentInputMapperSystem",
        ],
      }));

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
    // Phase 1: standard biped, 60 ticks of hold-forward.
    { kind: "tickSystems", systemIds: HEADLESS_WITH_BINDING_SWAP, ticks: 60, dt: 1 / 60 },
    // Inject BindingRequested → biped:agile.
    {
      kind: "mutate",
      fn: (reg) => {
        const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
        writeBuffer(events, (d) => {
          d.push({ type: "BindingRequested", payload: { bindingId: "biped:agile" } });
        });
      },
    },
    // Phase 2: agile biped, 60 more ticks. The first tick drains the
    // event + applies the new profile; ticks 2-60 integrate with it.
    { kind: "tickSystems", systemIds: HEADLESS_WITH_BINDING_SWAP, ticks: 60, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 16, axisGizmo: true },
};
