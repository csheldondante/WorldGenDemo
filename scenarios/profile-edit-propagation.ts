/**
 * Integration scenario for the ProfileEditor edit pipeline:
 *
 *   - applyProfileEdit(reg, "forwardVMax", value) mutates the active
 *     profile in CharacterControllerProfileBuffer.byId
 *   - tangentInputMapperSystem reads the new vMax on the next tick
 *   - the live character's velocity converges to the new target
 *
 * Same shape as binding-swap-propagation but exercises the editor's
 * direct mutation path (vs the binding-install path). Covers
 * `src/app/profileEditor.ts:applyProfileEdit` end-to-end.
 *
 * Two phases:
 *   1. Hold forward 60 ticks at the default vMax (5 m/s).
 *   2. mutate-step calls applyProfileEdit("forwardVMax", 12), then
 *      hold forward 60 more ticks. Final velocity converges to ~12.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { writeBuffer } from "../src/runtime/buffer";
import {
  applyProfileEdit,
  createProfileEditorBuffer,
  PROFILE_EDITOR_BUFFER_ID,
  type ProfileEditorBufferData,
} from "../src/app/profileEditor";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

export const test: BufferTest = {
  name: "profile-edit-propagation",
  description:
    "Hold KeyW on a flat plane for 60 ticks, then bump forwardVMax to 12 m/s " +
    "via applyProfileEdit + hold another 60 ticks. Verifies the editor's edit → " +
    "profile buffer → tangentInputMapper → controller path: live character " +
    "should converge to ~12 m/s instead of the default 5 m/s.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      // ProfileEditor's selector buffer isn't a core buffer — the
      // editor lives in src/app/ and registers it via bootstrap.
      // Tests that don't go through bootstrap need to register it
      // themselves (= the seed step does this).
      if (!reg.hasBuffer(PROFILE_EDITOR_BUFFER_ID)) {
        reg.registerBuffer(createProfileEditorBuffer());
      }
      // Point the editor at the seed character's profile id ("default" —
      // see seedPlayerOnSurface; the player references profile "default").
      writeBuffer(reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID), (d) => {
        d.activeProfileId = "default";
      });

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
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 60, dt: 1 / 60 },
    {
      kind: "mutate",
      fn: (reg) => {
        applyProfileEdit(reg, "forwardVMax", 12);
      },
    },
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 60, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 16, axisGizmo: true },
};
