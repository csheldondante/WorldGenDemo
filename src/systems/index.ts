/**
 * Canonical system registration. The TS code is the source of truth; the
 * generated docs/REGISTRY.md mirrors it for human searching.
 */

import type { Registry } from "../runtime/registry";
import { createStateMachineSystem } from "../runtime/stateMachine";
import { createAccumulator, createInputSystem, type InputAccumulator } from "./input";
import { createCameraMovementSystem } from "./cameraMovement";
import { createLoadSceneSystem } from "./loadScene";
import { createRenderSystem } from "./render";
import { createMinimapSystem } from "./minimap";
import { createHudSystem } from "./hud";
import { createParseBitmapSystem } from "./pipeline/parseBitmap";
import { createSplitLayersSystem } from "./pipeline/splitLayers";
import { createJfaSystem } from "./pipeline/jfa";
import { createHeightmapSystem } from "./pipeline/heightmap";
import { createTerrainMeshSystem } from "./pipeline/terrainMesh";
import { createAssetPlacementSystem } from "./pipeline/assetPlacement";

export interface CoreSystems {
  inputAccumulator: InputAccumulator;
}

/**
 * Register every V0 system into `reg`. Returns shared handles (e.g. the
 * input accumulator) the app shell needs to wire DOM listeners.
 */
export function registerCoreSystems(reg: Registry): CoreSystems {
  const inputAccumulator = createAccumulator();
  reg.registerSystem(createStateMachineSystem());
  reg.registerSystem(createInputSystem(inputAccumulator));
  reg.registerSystem(createCameraMovementSystem());
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
  return { inputAccumulator };
}

export * from "./input";
export * from "./cameraMovement";
export * from "./loadScene";
export * from "./render";
export * from "./minimap";
export * from "./hud";
export * from "./pipeline/parseBitmap";
export * from "./pipeline/splitLayers";
export * from "./pipeline/jfa";
export * from "./pipeline/heightmap";
export * from "./pipeline/terrainMesh";
export * from "./pipeline/assetPlacement";
