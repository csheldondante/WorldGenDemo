/**
 * Test: hold forward on a 200×200m flat plane for ~3 seconds.
 *
 * Uses the REAL bootstrap (`bootstrapApp`) with `holdKeysGenerator(["KeyW"])`
 * as the input source. The full real input pipeline runs (inputSystem →
 * inputMapper → characterInput → tangentInputMapper → characterController →
 * surfaceConstrainedVelocity → volumetricConstrainedVelocity →
 * surfaceConstraint → cameraFollow → characterRenderSync → bodyLean →
 * chainDynamics → footPlanner → footIk → skeletonWorld). Render and
 * skeletonDebugRender are excluded from the test step — the headless test
 * doesn't need either.
 *
 * After the run, every gameplay buffer is snapshotted and compared to the
 * baseline tree at `__baselines__/flat-plane-forward.json`. Default numeric
 * tolerance is 1e-6 absolute; per-path overrides live inline in the baseline.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { writeBuffer } from "../src/runtime/buffer";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../src/buffers/characterController";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../src/buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../src/buffers/velocity";
import { SURFACE_ATTACHMENT_BUFFER_ID, type SurfaceAttachmentBufferData } from "../src/buffers/surfaceAttachment";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../src/buffers/surfaceProvider";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../src/buffers/stateMachine";
import { ENTITY_BUFFER_ID, type EntityBufferData, spawnEntity } from "../src/buffers/entity";
import { CHARACTER_INPUT_BUFFER_ID, type CharacterInputBufferData, emptyInput } from "../src/buffers/characterInput";
import { SPHERE_BODY_BUFFER_ID, type SphereBodyBufferData } from "../src/buffers/sphereBody";
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../src/buffers/forceAccumulator";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../src/buffers/camera";
import { DEFAULT_PLAYER_PROFILE } from "../src/buffers/characterControllerProfile";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";

/**
 * Buffers we snapshot for comparison. Gameplay data only — `renderRefs`,
 * `worldData`, `surfaceProvider`, `characterControllerProfile`, and
 * `rigDefinition` hold class instances or DOM refs that the snapshot
 * serializer refuses (correctly — they're not "data" in the
 * "system-output as transformation" sense).
 */
const OUTPUT_BUFFERS = [
  "entity",
  "transform",
  "velocity",
  "characterController",
  "characterInput",
  "characterTangentInput",
  "forceAccumulator",
  "sphereBody",
  "surfaceAttachment",
  "skeleton",
  "footLock",
  "input",
  "inputMap",
  "camera",
  "stateMachine",
  "volumeField",
  "events",
  "timing",
];

/**
 * Systems that run each tick of this test. Mirrors the Running graph minus:
 *   - renderSystem (needs Three.js handles we don't wire up headless)
 *   - characterRenderSyncSystem (writes Three.js mesh transforms; pure side effect on RenderRefs)
 *   - skeletonDebugRenderSystem (also Three.js)
 *   - minimapSystem (writes a DOM canvas)
 *   - hudSystem (writes a DOM element)
 *
 * Everything else (input → mapper → character pipeline → camera follow →
 * body lean → chain dynamics → foot planner → foot IK → skeleton FK) is
 * exactly what real gameplay runs.
 */
const HEADLESS_GAMEPLAY_SYSTEMS = [
  "stateMachineSystem",
  "inputSystem",
  "inputMapperSystem",
  "characterInputSystem",
  "tangentInputMapperSystem",
  "characterOrientationSystem",
  "forceFieldSystem",
  "characterControllerSystem",
  "surfaceConstrainedVelocitySystem",
  "volumetricConstrainedVelocitySystem",
  "surfaceConstraintSystem",
  "cameraFollowSystem",
  "bodyLeanSystem",
  "chainDynamicsSystem",
  "footPlannerSystem",
  "footIkSystem",
  "skeletonWorldSystem",
];

export const test: BufferTest = {
  name: "flat-plane-forward",
  description:
    "200×200m flat PlaneSurfaceProvider. Player holds KeyW for 180 ticks at 60Hz (~3s). " +
    "Drives the real Running pipeline minus render/HUD. Verifies convergent forward speed " +
    "with no lateral or vertical drift across every gameplay buffer.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      // Force SM to Running so we don't need to run the bitmap pipeline.
      writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
        d.state = "Running";
        d.activeGraph = "Running";
        d.pendingEvents = [];
        d.pendingLoad = null;
        d.pendingRebuild = null;
      });
      // Camera yaw = π so KeyW (forward) projects to +Z on the tangent plane.
      writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
        d.yaw = Math.PI;
        d.pitch = 0;
      });

      // 200×200m plane at world origin. tangentU=+X, tangentV=-Z; normal=+Y.
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
      const sample = provider.sampleAtUV(0.5, 0.5);
      const radius = DEFAULT_PLAYER_PROFILE.bodyRadius;

      writeBuffer(reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID), (d) => {
        d.heightmap = provider;
      });

      let playerId = -1;
      writeBuffer(reg.getBuffer<EntityBufferData>(ENTITY_BUFFER_ID), (d) => {
        playerId = spawnEntity(d);
      });
      writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
        d.byEntity.set(playerId, {
          position: [
            sample.position[0] + sample.normal[0] * radius,
            sample.position[1] + sample.normal[1] * radius,
            sample.position[2] + sample.normal[2] * radius,
          ],
          yaw: Math.PI,
          scale: 1,
        });
      });
      writeBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID), (d) => {
        d.byEntity.set(playerId, { linear: [0, 0, 0], prevLinear: [0, 0, 0] });
      });
      writeBuffer(reg.getBuffer<SphereBodyBufferData>(SPHERE_BODY_BUFFER_ID), (d) => {
        d.byEntity.set(playerId, { radius });
      });
      writeBuffer(reg.getBuffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID), (d) => {
        d.byEntity.set(playerId, { accel: [0, 0, 0] });
      });
      writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
        d.byEntity.set(playerId, {
          state: "surfaceRun",
          locomotionMode: "surfaceConstrained",
          profileId: DEFAULT_PLAYER_PROFILE.id,
          lastTransitionReason: "spawn",
          transitions: [],
          timeInState: 0,
          yawVel: 0,
          targetYaw: Math.PI,
          bodyUpCurrent: [0, 0, 0, 1],
          bodyUpWorld: [0, 1, 0],
          orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
        });
      });
      writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
        d.byEntity.set(playerId, emptyInput(Math.PI));
      });
      writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
        d.byEntity.set(playerId, {
          surfaceId: provider.id,
          uv: [0.5, 0.5],
          offsetAlongNormal: radius,
          sample,
        });
      });
    },
  },
  steps: [
    {
      kind: "tickSystems",
      systemIds: HEADLESS_GAMEPLAY_SYSTEMS,
      ticks: 180,
      dt: 1 / 60,
    },
  ],
  output: {
    snapshot: OUTPUT_BUFFERS,
  },
};
