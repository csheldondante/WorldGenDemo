/**
 * Canonical system registration. The TS code is the source of truth; the
 * generated docs/REGISTRY.md mirrors it for human searching.
 */

import type { Registry } from "../runtime/registry";
import type { SystemDescriptor } from "../runtime/system";
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
import { createParametricSurfaceSystem } from "./pipeline/parametricSurface";
import { createPlayerSpawnSystem } from "./pipeline/playerSpawn";
// V1 character systems
import { createCharacterInputSystem } from "./characterInput";
import { createTangentInputMapperSystem } from "./tangentInputMapper";
import { createCharacterOrientationSystem } from "./characterOrientation";
import { createForceFieldSystem } from "./forceField";
import { createCharacterControllerSystem } from "./characterController";
import { createSurfaceConstrainedVelocitySystem } from "./surfaceConstrainedVelocity";
import { createVolumetricConstrainedVelocitySystem } from "./volumetricConstrainedVelocity";
import { createSurfaceConstraintSystem } from "./surfaceConstraint";
import { createCameraPivotSystem } from "./cameraPivot";
import { createCameraOrbitSystem } from "./cameraOrbit";
import { createDebugGizmoSystem } from "./debugGizmo";
import {
  createInputRecordingSystem,
  createInputRecordingState,
  type InputRecordingState,
} from "./testing/inputRecording";
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
  /**
   * State for the always-registered InputRecordingSystem. `.active` is
   * false by default; the scenario menu's Record button flips it on,
   * Esc/Stop flips it off. Normal play never touches it, costing zero
   * per-tick work beyond a single flag check.
   */
  inputRecordingState: InputRecordingState;
}

export interface RegisterCoreSystemsOptions {
  /**
   * Optional ADDITIONAL input source — a SystemDescriptor with id
   * `SCRIPTED_INPUT_SYSTEM_ID` (= the canonical id for non-DOM input
   * variants: simulated, playback, virtual). Registered ALONGSIDE the
   * live DOM `inputSystem`; the active mode's `systems` list selects
   * which one actually runs in any given graph. Both ids are listed
   * in downstream `runsAfter` so the consumers work with either.
   *
   * Headless test setups register only the scripted variant + tick a
   * graph that references the scripted id. Browser scenario playback
   * registers both + lets the user swap via mode change.
   */
  inputSystem?: SystemDescriptor;
}

/**
 * Register every V0 system into `reg`. Returns shared handles (e.g. the
 * input accumulator) the app shell needs to wire DOM listeners.
 *
 * Accepts an optional `inputSystem` override so the scenario harness can use
 * the real graphs + buffers + systems and just swap the input source — that
 * preserves the data-oriented architecture (tests are differentiated by which
 * systems they enable and the data they load, not by parallel test code).
 */
export function registerCoreSystems(reg: Registry, options: RegisterCoreSystemsOptions = {}): CoreSystems {
  const inputAccumulator = createAccumulator();
  const builderAccumulator = createBuilderAccumulator();
  const builderDom = createBuilderDom();
  reg.registerSystem(createStateMachineSystem());
  // Live DOM input — always registered. Scripted variants (if any)
  // register under the sibling SCRIPTED_INPUT_SYSTEM_ID. The active
  // mode's `systems` list picks which one ticks each frame.
  reg.registerSystem(createInputSystem(inputAccumulator));
  if (options.inputSystem) reg.registerSystem(options.inputSystem);
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
  reg.registerSystem(createParametricSurfaceSystem());
  reg.registerSystem(createPlayerSpawnSystem());
  reg.registerSystem(createBuilderInputSystem(builderAccumulator));
  reg.registerSystem(createBuilderSystem(builderAccumulator, builderDom));
  // V1 character systems (Running graph)
  reg.registerSystem(createCharacterInputSystem());
  reg.registerSystem(createTangentInputMapperSystem());
  reg.registerSystem(createCharacterOrientationSystem());
  reg.registerSystem(createForceFieldSystem());
  reg.registerSystem(createCharacterControllerSystem());
  reg.registerSystem(createSurfaceConstrainedVelocitySystem());
  reg.registerSystem(createVolumetricConstrainedVelocitySystem());
  reg.registerSystem(createSurfaceConstraintSystem());
  reg.registerSystem(createCameraPivotSystem());
  reg.registerSystem(createCameraOrbitSystem());
  reg.registerSystem(createDebugGizmoSystem());
  // Always-registered input recording system; inert until state.active=true.
  const inputRecordingState = createInputRecordingState();
  reg.registerSystem(createInputRecordingSystem(inputRecordingState));
  reg.registerSystem(createCharacterRenderSyncSystem());
  reg.registerSystem(createBodyLeanSystem());
  reg.registerSystem(createChainDynamicsSystem());
  reg.registerSystem(createFootPlannerSystem());
  reg.registerSystem(createFootIkSystem());
  reg.registerSystem(createSkeletonWorldSystem());
  reg.registerSystem(createSkeletonDebugRenderSystem());
  return { inputAccumulator, builderAccumulator, builderDom, inputRecordingState };
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
export * from "./pipeline/parametricSurface";
export * from "./pipeline/playerSpawn";
export * from "./characterInput";
export * from "./tangentInputMapper";
export * from "./characterOrientation";
export * from "./forceField";
export * from "./characterController";
export * from "./surfaceConstrainedVelocity";
export * from "./volumetricConstrainedVelocity";
export * from "./surfaceConstraint";
export * from "./cameraPivot";
export * from "./cameraOrbit";
export * from "./debugGizmo";
export * from "./testing/inputRecording";
export * from "./characterRenderSync";
export * from "./bodyLean";
export * from "./chainDynamics";
export * from "./footPlanner";
export * from "./footIk";
export * from "./skeletonWorld";
export * from "./skeletonDebugRender";
