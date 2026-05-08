import { buildExecutionGraph, type ExecutionGraph } from "../runtime/graph";
import type { Registry } from "../runtime/registry";

import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_SYSTEM_ID } from "../systems/input";
import { CAMERA_MOVEMENT_SYSTEM_ID } from "../systems/cameraMovement";
import { RENDER_SYSTEM_ID } from "../systems/render";
import { MINIMAP_SYSTEM_ID } from "../systems/minimap";
import { HUD_SYSTEM_ID } from "../systems/hud";
import { PARSE_BITMAP_SYSTEM_ID } from "../systems/pipeline/parseBitmap";
import { SPLIT_LAYERS_SYSTEM_ID } from "../systems/pipeline/splitLayers";
import { JFA_SYSTEM_ID } from "../systems/pipeline/jfa";
import { HEIGHTMAP_SYSTEM_ID } from "../systems/pipeline/heightmap";
import { TERRAIN_MESH_SYSTEM_ID } from "../systems/pipeline/terrainMesh";
import { ASSET_PLACEMENT_SYSTEM_ID } from "../systems/pipeline/assetPlacement";

export const RUNNING_GRAPH_ID = "Running";
export const REBUILDING_GRAPH_ID = "Rebuilding";

/**
 * Build and register the V0 graphs. Both are validated (cycle, hazards) at
 * registration time; if any contract is violated, this throws before the
 * loop starts.
 */
export function buildAndRegisterCoreGraphs(reg: Registry): {
  running: ExecutionGraph;
  rebuilding: ExecutionGraph;
} {
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

  reg.registerGraph(running);
  reg.registerGraph(rebuilding);

  return { running, rebuilding };
}
