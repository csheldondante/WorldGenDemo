import { buildExecutionGraph, type ExecutionGraph } from "../runtime/graph";
import type { Registry } from "../runtime/registry";

import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_SYSTEM_ID } from "../systems/input";
import { INPUT_MAPPER_SYSTEM_ID } from "../systems/inputMapper";
import { LOAD_SCENE_SYSTEM_ID } from "../systems/loadScene";
import { RENDER_SYSTEM_ID } from "../systems/render";
import { MINIMAP_SYSTEM_ID } from "../systems/minimap";
import { HUD_SYSTEM_ID } from "../systems/hud";
import { PARSE_BITMAP_SYSTEM_ID } from "../systems/pipeline/parseBitmap";
import { SPLIT_LAYERS_SYSTEM_ID } from "../systems/pipeline/splitLayers";
import { JFA_SYSTEM_ID } from "../systems/pipeline/jfa";
import { HEIGHTMAP_SYSTEM_ID } from "../systems/pipeline/heightmap";
import { TERRAIN_MESH_SYSTEM_ID } from "../systems/pipeline/terrainMesh";
import { ASSET_PLACEMENT_SYSTEM_ID } from "../systems/pipeline/assetPlacement";
import { SURFACE_PROVIDER_SYSTEM_ID } from "../systems/pipeline/surfaceProvider";
import { PARAMETRIC_SURFACE_SYSTEM_ID } from "../systems/pipeline/parametricSurface";
import { PLAYER_SPAWN_SYSTEM_ID } from "../systems/pipeline/playerSpawn";
import { BUILDER_INPUT_SYSTEM_ID } from "../systems/builderInput";
import { BUILDER_SYSTEM_ID } from "../systems/builder";
// V1 character per-frame systems
import { CHARACTER_INPUT_SYSTEM_ID } from "../systems/characterInput";
import { TANGENT_INPUT_MAPPER_SYSTEM_ID } from "../systems/tangentInputMapper";
import { CHARACTER_ORIENTATION_SYSTEM_ID } from "../systems/characterOrientation";
import { FORCE_FIELD_SYSTEM_ID } from "../systems/forceField";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "../systems/characterController";
import { SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID } from "../systems/surfaceConstrainedVelocity";
import { VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID } from "../systems/volumetricConstrainedVelocity";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "../systems/surfaceConstraint";
import { CAMERA_PIVOT_SYSTEM_ID } from "../systems/cameraPivot";
import { CAMERA_ORBIT_SYSTEM_ID } from "../systems/cameraOrbit";
import { CHARACTER_RENDER_SYNC_SYSTEM_ID } from "../systems/characterRenderSync";
import { BODY_LEAN_SYSTEM_ID } from "../systems/bodyLean";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "../systems/chainDynamics";
import { FOOT_PLANNER_SYSTEM_ID } from "../systems/footPlanner";
import { FOOT_IK_SYSTEM_ID } from "../systems/footIk";
import { SKELETON_WORLD_SYSTEM_ID } from "../systems/skeletonWorld";
import { SKELETON_DEBUG_RENDER_SYSTEM_ID } from "../systems/skeletonDebugRender";

export const LOADING_GRAPH_ID = "Loading";
export const RUNNING_GRAPH_ID = "Running";
export const REBUILDING_GRAPH_ID = "Rebuilding";
export const BUILDER_GRAPH_ID = "Builder";

/**
 * Build and register the runtime graphs. Validated (cycle + hazards) at
 * registration time; throws before the loop starts on any contract violation.
 */
export function buildAndRegisterCoreGraphs(reg: Registry): {
  loading: ExecutionGraph;
  running: ExecutionGraph;
  rebuilding: ExecutionGraph;
  builder: ExecutionGraph;
} {
  // Loading graph: just SM + Input + LoadScene + Render + Hud. No camera
  // movement (the camera is static on the placeholder background until the
  // world is built).
  const loading = buildExecutionGraph({
    id: LOADING_GRAPH_ID,
    nodes: [
      STATE_MACHINE_SYSTEM_ID,
      INPUT_SYSTEM_ID,
      LOAD_SCENE_SYSTEM_ID,
      RENDER_SYSTEM_ID,
      HUD_SYSTEM_ID,
    ],
    registry: reg,
  });

  // Running graph: full per-frame character pipeline.
  const running = buildExecutionGraph({
    id: RUNNING_GRAPH_ID,
    nodes: [
      STATE_MACHINE_SYSTEM_ID,
      INPUT_SYSTEM_ID,
      INPUT_MAPPER_SYSTEM_ID,
      CHARACTER_INPUT_SYSTEM_ID,
      TANGENT_INPUT_MAPPER_SYSTEM_ID,
      CHARACTER_ORIENTATION_SYSTEM_ID,
      FORCE_FIELD_SYSTEM_ID,
      CHARACTER_CONTROLLER_SYSTEM_ID,
      SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID,
      VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID,
      SURFACE_CONSTRAINT_SYSTEM_ID,
      CAMERA_PIVOT_SYSTEM_ID,
      CAMERA_ORBIT_SYSTEM_ID,
      CHARACTER_RENDER_SYNC_SYSTEM_ID,
      BODY_LEAN_SYSTEM_ID,
      CHAIN_DYNAMICS_SYSTEM_ID,
      FOOT_PLANNER_SYSTEM_ID,
      FOOT_IK_SYSTEM_ID,
      SKELETON_WORLD_SYSTEM_ID,
      SKELETON_DEBUG_RENDER_SYSTEM_ID,
      RENDER_SYSTEM_ID,
      MINIMAP_SYSTEM_ID,
      HUD_SYSTEM_ID,
    ],
    registry: reg,
  });

  const rebuilding = buildExecutionGraph({
    id: REBUILDING_GRAPH_ID,
    nodes: [
      STATE_MACHINE_SYSTEM_ID,
      PARSE_BITMAP_SYSTEM_ID,
      SPLIT_LAYERS_SYSTEM_ID,
      JFA_SYSTEM_ID,
      HEIGHTMAP_SYSTEM_ID,
      TERRAIN_MESH_SYSTEM_ID,
      ASSET_PLACEMENT_SYSTEM_ID,
      SURFACE_PROVIDER_SYSTEM_ID,
      PARAMETRIC_SURFACE_SYSTEM_ID,
      PLAYER_SPAWN_SYSTEM_ID,
      RENDER_SYSTEM_ID,
      HUD_SYSTEM_ID,
    ],
    registry: reg,
  });

  // Builder graph: SM → BuilderInput → BuilderSystem → Hud. No Render — the
  // editor's DOM panel is on top of the world canvas.
  const builder = buildExecutionGraph({
    id: BUILDER_GRAPH_ID,
    nodes: [
      STATE_MACHINE_SYSTEM_ID,
      BUILDER_INPUT_SYSTEM_ID,
      BUILDER_SYSTEM_ID,
      HUD_SYSTEM_ID,
    ],
    registry: reg,
  });

  reg.registerGraph(loading);
  reg.registerGraph(running);
  reg.registerGraph(rebuilding);
  reg.registerGraph(builder);

  return { loading, running, rebuilding, builder };
}
