import { buildExecutionGraph, type ExecutionGraph } from "../runtime/graph";
import type { Registry } from "../runtime/registry";

import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_SYSTEM_ID } from "../systems/input";
import { CAMERA_MOVEMENT_SYSTEM_ID } from "../systems/cameraMovement";
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
import { BUILDER_INPUT_SYSTEM_ID } from "../systems/builderInput";
import { BUILDER_SYSTEM_ID } from "../systems/builder";

export const LOADING_GRAPH_ID = "Loading";
export const RUNNING_GRAPH_ID = "Running";
export const REBUILDING_GRAPH_ID = "Rebuilding";
export const BUILDER_GRAPH_ID = "Builder";

/**
 * Build and register the V0 graphs. Both are validated (cycle, hazards) at
 * registration time; if any contract is violated, this throws before the
 * loop starts.
 */
export function buildAndRegisterCoreGraphs(reg: Registry): {
  loading: ExecutionGraph;
  running: ExecutionGraph;
  rebuilding: ExecutionGraph;
  builder: ExecutionGraph;
} {
  const loading = buildExecutionGraph({
    id: LOADING_GRAPH_ID,
    nodes: [
      STATE_MACHINE_SYSTEM_ID,
      INPUT_SYSTEM_ID,
      CAMERA_MOVEMENT_SYSTEM_ID,
      LOAD_SCENE_SYSTEM_ID,
      RENDER_SYSTEM_ID,
      HUD_SYSTEM_ID,
    ],
    registry: reg,
  });

  const running = buildExecutionGraph({
    id: RUNNING_GRAPH_ID,
    nodes: [
      STATE_MACHINE_SYSTEM_ID,
      INPUT_SYSTEM_ID,
      CAMERA_MOVEMENT_SYSTEM_ID,
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
      RENDER_SYSTEM_ID,
      HUD_SYSTEM_ID,
      // MinimapSystem is in Running graph only — minimap is a per-frame overlay.
    ],
    registry: reg,
  });

  // Builder graph: SM → BuilderInput → BuilderSystem → Hud. No Render or Minimap —
  // the editor's DOM panel is on top, the world canvas is hidden behind it, and
  // re-running the splat shader every frame in builder mode is wasted work.
  // (Phase 3 may add a tiny preview render system if needed.)
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
