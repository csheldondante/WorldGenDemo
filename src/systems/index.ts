/**
 * Canonical system registration. The TS code is the source of truth; the
 * generated docs/REGISTRY.md mirrors it for human searching.
 */

import type { Registry } from "../runtime/registry";
import { createStateMachineSystem } from "../runtime/stateMachine";
import { createAccumulator, createInputSystem, type InputAccumulator } from "./input";
import { createInputMapperSystem } from "./inputMapper";
import { createLoadSceneSystem } from "./loadScene";
import { createBuilderAccumulator, createBuilderInputSystem, createBuilderDom, type BuilderInputAccumulator, type BuilderDom } from "./builderInput";
import { createBuilderSystem } from "./builder";
import { createRenderSystem } from "./render";
import { createMinimapSystem } from "./minimap";
import { createHudSystem } from "./hud";
import { createParseBitmapSystem } from "./pipeline/parseBitmap";
import { createSplitLayersSystem } from "./pipeline/splitLayers";
import { createJfaSystem } from "./pipeline/jfa";
import { createHeightmapSystem } from "./pipeline/heightmap";
import { createTerrainMeshSystem } from "./pipeline/terrainMesh";
import { createAssetPlacementSystem } from "./pipeline/assetPlacement";
import { createSurfaceProviderSystem } from "./pipeline/surfaceProvider";
import { createPlayerSpawnSystem } from "./pipeline/playerSpawn";
// V1 character systems
import { createCharacterInputSystem } from "./characterInput";
import { createCharacterOrientationSystem } from "./characterOrientation";
import { createForceFieldSystem } from "./forceField";
import { createCharacterControllerSystem } from "./characterController";
import { createVelocityIntegrationSystem } from "./velocityIntegration";
import { createSurfaceConstraintSystem } from "./surfaceConstraint";
import { createCameraFollowSystem } from "./cameraFollow";
import { createCharacterRenderSyncSystem } from "./characterRenderSync";
import { createBodyLeanSystem } from "./bodyLean";
import { createChainDynamicsSystem } from "./chainDynamics";
import { createFootPlannerSystem } from "./footPlanner";
import { createFootIkSystem } from "./footIk";
import { createSkeletonWorldSystem } from "./skeletonWorld";
import { createSkeletonDebugRenderSystem } from "./skeletonDebugRender";

export interface CoreSystems {
  inputAccumulator: InputAccumulator;
  builderAccumulator: BuilderInputAccumulator;
  builderDom: BuilderDom;
}

/**
 * Register every V0 system into `reg`. Returns shared handles (e.g. the
 * input accumulator) the app shell needs to wire DOM listeners.
 */
export function registerCoreSystems(reg: Registry): CoreSystems {
  const inputAccumulator = createAccumulator();
  const builderAccumulator = createBuilderAccumulator();
  const builderDom = createBuilderDom();
  reg.registerSystem(createStateMachineSystem());
  reg.registerSystem(createInputSystem(inputAccumulator));
  reg.registerSystem(createInputMapperSystem());
  reg.registerSystem(createLoadSceneSystem());
  reg.registerSystem(createRenderSystem());
  reg.registerSystem(createMinimapSystem());
  reg.registerSystem(createHudSystem());
  reg.registerSystem(createParseBitmapSystem());
  reg.registerSystem(createSplitLayersSystem());
  reg.registerSystem(createJfaSystem());
  reg.registerSystem(createHeightmapSystem());
  reg.registerSystem(createTerrainMeshSystem());
  reg.registerSystem(createAssetPlacementSystem());
  reg.registerSystem(createSurfaceProviderSystem());
  reg.registerSystem(createPlayerSpawnSystem());
  reg.registerSystem(createBuilderInputSystem(builderAccumulator));
  reg.registerSystem(createBuilderSystem(builderAccumulator, builderDom));
  // V1 character systems (Running graph)
  reg.registerSystem(createCharacterInputSystem());
  reg.registerSystem(createCharacterOrientationSystem());
  reg.registerSystem(createForceFieldSystem());
  reg.registerSystem(createCharacterControllerSystem());
  reg.registerSystem(createVelocityIntegrationSystem());
  reg.registerSystem(createSurfaceConstraintSystem());
  reg.registerSystem(createCameraFollowSystem());
  reg.registerSystem(createCharacterRenderSyncSystem());
  reg.registerSystem(createBodyLeanSystem());
  reg.registerSystem(createChainDynamicsSystem());
  reg.registerSystem(createFootPlannerSystem());
  reg.registerSystem(createFootIkSystem());
  reg.registerSystem(createSkeletonWorldSystem());
  reg.registerSystem(createSkeletonDebugRenderSystem());
  return { inputAccumulator, builderAccumulator, builderDom };
}

export * from "./input";
export * from "./inputMapper";
export * from "./loadScene";
export * from "./render";
export * from "./minimap";
export * from "./hud";
export * from "./builderInput";
export * from "./builder";
export * from "./pipeline/parseBitmap";
export * from "./pipeline/splitLayers";
export * from "./pipeline/jfa";
export * from "./pipeline/heightmap";
export * from "./pipeline/terrainMesh";
export * from "./pipeline/assetPlacement";
export * from "./pipeline/surfaceProvider";
export * from "./pipeline/playerSpawn";
export * from "./characterInput";
export * from "./characterOrientation";
export * from "./forceField";
export * from "./characterController";
export * from "./velocityIntegration";
export * from "./surfaceConstraint";
export * from "./cameraFollow";
export * from "./characterRenderSync";
export * from "./bodyLean";
export * from "./chainDynamics";
export * from "./footPlanner";
export * from "./footIk";
export * from "./skeletonWorld";
export * from "./skeletonDebugRender";
