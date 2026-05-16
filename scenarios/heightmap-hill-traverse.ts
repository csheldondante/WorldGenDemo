/**
 * Test: walk forward over a heightmap hill for ~4 seconds.
 *
 * Synthesizes a 64×64 heightmap with a smooth Gaussian hill near the south
 * edge of the player's path. Player spawns south of the hill, holds KeyW
 * (forward → +Z direction at cameraYaw=π), walks up + over + down the back side.
 *
 * Catches the "momentum dies on hills" regression class: any change that
 * causes the character to momentarily detach on bumps (and lose friction
 * grip) will show up here as a different terminal position + non-monotonic
 * velocity.
 *
 * Drives the SAME headless gameplay pipeline as flat-plane-forward (real
 * Running graph minus render/HUD), just with a HeightmapSurfaceProvider in
 * place of PlaneSurfaceProvider.
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
import { HeightmapSurfaceProvider } from "../src/world/surfaceProvider";
import type { Heightmap } from "../src/map/heightmap";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";

const OUTPUT_BUFFERS = [
  "entity", "transform", "velocity", "characterController", "characterInput",
  "characterTangentInput", "forceAccumulator", "sphereBody", "surfaceAttachment",
  "skeleton", "footLock", "input", "inputMap", "camera", "stateMachine",
  "volumeField", "events", "timing",
];

const HEADLESS_GAMEPLAY_SYSTEMS = [
  "stateMachineSystem",
  "inputSystem", "inputMapperSystem", "characterInputSystem",
  "tangentInputMapperSystem", "characterOrientationSystem",
  "forceFieldSystem", "characterControllerSystem",
  "surfaceConstrainedVelocitySystem", "volumetricConstrainedVelocitySystem",
  "surfaceConstraintSystem", "cameraFollowSystem",
  "bodyLeanSystem", "chainDynamicsSystem", "footPlannerSystem",
  "footIkSystem", "skeletonWorldSystem",
];

/**
 * Build a 64×64 heightmap with a Gaussian hill peaking at row=20 (south of
 * center). Tile size = 1m. Player spawns at row=40 (further south), walks
 * north (+Z direction at cameraYaw=π → forward = +Z). The hill rises to
 * ~3.5m at its peak — well within slopeRunMaxRad for the default profile.
 */
function buildHillHeightmap(): Heightmap {
  const W = 64;
  const H = 64;
  const TILE = 1;
  const data = new Float32Array(W * H);
  const peakCol = 32;
  const peakRow = 20;
  const peakElev = 3.5;
  const sigma = 8.0; // ~Gaussian width
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const dx = c - peakCol;
      const dz = r - peakRow;
      const dist2 = dx * dx + dz * dz;
      data[r * W + c] = peakElev * Math.exp(-dist2 / (2 * sigma * sigma));
    }
  }
  return { width: W, height: H, tileSize: TILE, data };
}

export const test: BufferTest = {
  name: "heightmap-hill-traverse",
  description:
    "64×64 heightmap with a Gaussian hill (peak 3.5m, σ≈8m). Player spawns south of the " +
    "hill, holds KeyW for 240 ticks at 60Hz (~4s). Drives the real Running pipeline minus " +
    "render/HUD. Tests momentum preservation across surface curvature — catches the " +
    "\"momentum dies on hills\" regression class where strict detach/land checks fail at " +
    "small bumps.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
        d.state = "Running";
        d.activeGraph = "Running";
        d.pendingEvents = [];
        d.pendingLoad = null;
        d.pendingRebuild = null;
      });
      writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
        d.yaw = Math.PI; // forward → +Z
        d.pitch = 0;
      });

      const hm = buildHillHeightmap();
      const provider = new HeightmapSurfaceProvider("hill", hm);

      // Spawn UV: north of the hill at uv.v=0.05 (row=3). KeyW at cameraYaw=π
      // drives forward → +Z which increases v (row index). The hill peak sits
      // at row=20 (uv.v≈0.31), and the player traverses up + over + down at
      // ~6 m/s steady speed (~12 rows/sec). Ending at v≈0.42 puts them well
      // past the peak, still inside heightmap bounds.
      const spawnUV: [number, number] = [0.5, 0.05];
      const sample = provider.sampleAtUV(spawnUV[0], spawnUV[1]);
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
          uv: [spawnUV[0], spawnUV[1]],
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
      ticks: 240,
      dt: 1 / 60,
    },
  ],
  output: {
    snapshot: OUTPUT_BUFFERS,
  },
  // Render-only: heightmap wireframe at higher resolution so the hill is
  // recognizable; axis gizmo for orientation.
  backdrop: {
    surfaceDebugMesh: true,
    surfaceMeshResolution: 48,
    axisGizmo: true,
  },
};
