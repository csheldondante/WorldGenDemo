/**
 * Shared scenario seed helpers. Dedup boilerplate: spawn a player entity on a
 * given SurfaceProvider at a given UV, force SM=Running, set camera yaw so
 * KeyW maps to a chosen world direction. Used by most BufferTest scenarios.
 *
 * No system imports — scenarios stay easy to read; the helper only touches
 * the runtime via the registry, same way the original inline seeds did.
 */
import type { Registry } from "../src/runtime/registry";
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
import type { SurfaceProvider } from "../src/world/surfaceProvider";

/**
 * Output-snapshot list — every gameplay buffer worth comparing across runs.
 * Excludes render-side buffers (renderRefs, worldData, surfaceProvider — they
 * hold class/DOM references the serializer refuses).
 */
export const GAMEPLAY_OUTPUT_BUFFERS = [
  "entity", "transform", "velocity", "characterController", "characterInput",
  "characterTangentInput", "forceAccumulator", "sphereBody", "surfaceAttachment",
  "skeleton", "footLock", "input", "inputMap", "camera", "stateMachine",
  "volumeField", "events", "timing",
];

/**
 * The 17-system Running graph minus render/HUD/minimap/skeletonDebug. Headless
 * gameplay: input → mapper → character pipeline → physics → camera follow →
 * skeleton FK. Same set every gameplay scenario uses.
 */
export const HEADLESS_GAMEPLAY_SYSTEMS = [
  "stateMachineSystem",
  "inputSystem", "inputMapperSystem", "characterInputSystem",
  "tangentInputMapperSystem", "characterOrientationSystem",
  "forceFieldSystem", "characterControllerSystem",
  "surfaceConstrainedVelocitySystem", "volumetricConstrainedVelocitySystem",
  "surfaceConstraintSystem", "cameraPivotSystem", "cameraOrbitSystem",
  "bodyLeanSystem", "chainDynamicsSystem", "footPlannerSystem",
  "footIkSystem", "skeletonWorldSystem",
];

/**
 * Subset for input+camera-only scenarios (no player physics). 4 systems.
 */
export const HEADLESS_INPUT_CAMERA_SYSTEMS = [
  "stateMachineSystem",
  "inputSystem", "inputMapperSystem", "cameraPivotSystem", "cameraOrbitSystem",
];

export interface SeedPlayerOpts {
  /** UV to spawn at. */
  uv: [number, number];
  /** Camera yaw in radians. Default π → KeyW maps to +Z. */
  cameraYaw?: number;
  /** Initial body yaw (Transform.yaw). Default matches cameraYaw. */
  bodyYaw?: number;
}

/**
 * Force SM=Running, set camera yaw, register the SurfaceProvider, and spawn a
 * single player entity at the given UV with default profile + bodyRadius
 * offset above the surface. Returns the spawned entity id.
 */
export function seedPlayerOnSurface(
  reg: Registry,
  provider: SurfaceProvider,
  opts: SeedPlayerOpts,
): number {
  const cameraYaw = opts.cameraYaw ?? Math.PI;
  const bodyYaw = opts.bodyYaw ?? cameraYaw;
  const sample = provider.sampleAtUV(opts.uv[0], opts.uv[1]);
  const radius = DEFAULT_PLAYER_PROFILE.bodyRadius;

  writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
    d.state = "Running";
    d.activeGraph = "Running";
    d.pendingEvents = [];
    d.pendingLoad = null;
    d.pendingRebuild = null;
  });
  writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
    d.yaw = cameraYaw;
    d.pitch = 0;
    // target tracks rendered state — keep them in agreement at spawn so
    // CameraOrbitSystem doesn't snap to a stale target on the first tick.
    // target.pitch keeps the buffer default (atan(2.6/6) ≈ 0.41 above
    // horizon — flat-gravity equivalent of the pre-refactor +2.6m height).
    d.target.yaw = cameraYaw;
  });
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
      yaw: bodyYaw,
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
      targetYaw: bodyYaw,
      bodyUpCurrent: [0, 0, 0, 1],
      bodyUpWorld: [0, 1, 0],
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      desiredFacingTangent: [0, 0, -1],
      jumpHolding: false,
      jumpDir: [0, 0, 0],
      jumpImpulseMagMax: 0,
      jumpImpulseApplied: 0,
    });
  });
  writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
    d.byEntity.set(playerId, emptyInput(cameraYaw));
  });
  writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
    d.byEntity.set(playerId, {
      surfaceId: provider.id,
      uv: [opts.uv[0], opts.uv[1]],
      offsetAlongNormal: radius,
      sample,
    });
  });
  return playerId;
}
