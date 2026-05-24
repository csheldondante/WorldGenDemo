import { buildExecutionGraph, type ExecutionGraph } from "../runtime/graph";
import type { Registry } from "../runtime/registry";

import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_SYSTEM_ID } from "../systems/input";
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
import { DEBUG_GIZMO_SYSTEM_ID } from "../systems/debugGizmo";
import { INPUT_RECORDING_SYSTEM_ID } from "../systems/testing/inputRecording";
import { bipedDefaultSystemIds } from "./bipedBinding";

export const LOADING_GRAPH_ID = "Loading";
export const RUNNING_GRAPH_ID = "Running";
export const REBUILDING_GRAPH_ID = "Rebuilding";
export const BUILDER_GRAPH_ID = "Builder";

/**
 * Non-character systems in the Running graph — runtime infrastructure
 * (state machine, input pipeline + recording) and output (debug
 * gizmo, render, minimap, hud). The biped binding contributes the
 * CHARACTER systems via `bipedDefaultSystemIds()`; the full Running
 * graph is the union.
 *
 * Phase 4d (2026-05-23): the Running graph is now derived from the
 * biped binding for its character-system slice, rather than hand-
 * curated. Future archetype bindings (= vehicle, drone) can swap the
 * character slice without touching the runtime/render systems here.
 */
const RUNNING_NON_CHARACTER_PRE_SYSTEMS = [
  STATE_MACHINE_SYSTEM_ID,
  INPUT_RECORDING_SYSTEM_ID,  // wraps input; precedes mapping (= part of normalization layer)
  "bindingSwapSystem",        // drains BindingRequested events → applies binding
  "overlayVisibilitySystem",  // toggles LibraryViewer panel based on activeMode
];
const RUNNING_NON_CHARACTER_POST_SYSTEMS = [
  DEBUG_GIZMO_SYSTEM_ID,
  RENDER_SYSTEM_ID,
  MINIMAP_SYSTEM_ID,
  HUD_SYSTEM_ID,
];

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
  // Loading graph: SM + Input + LoadScene + Render + Hud + the
  // transition activator (= observes SM state to switch into the
  // Rebuilding transition when state moves to Rebuilding). No camera
  // movement (the camera is static on the placeholder background
  // until the world is built).
  const loading = buildExecutionGraph({
    id: LOADING_GRAPH_ID,
    nodes: [
      STATE_MACHINE_SYSTEM_ID,
      "transitionActivatorSystem",
      INPUT_SYSTEM_ID,
      LOAD_SCENE_SYSTEM_ID,
      RENDER_SYSTEM_ID,
      HUD_SYSTEM_ID,
    ],
    registry: reg,
  });

  // Running graph: full per-frame character pipeline.
  //
  // Phase 4d: character-systems slice is derived from the biped
  // default binding (= `bipedDefaultSystemIds`), with runtime/render
  // systems wrapped around it. Order within nodes doesn't matter —
  // buildExecutionGraph topo-sorts by declared dependencies. Future
  // archetypes swap the character slice by substituting a different
  // ControllerBinding's resolved system list.
  const running = buildExecutionGraph({
    id: RUNNING_GRAPH_ID,
    nodes: [
      ...RUNNING_NON_CHARACTER_PRE_SYSTEMS,
      ...bipedDefaultSystemIds(),
      ...RUNNING_NON_CHARACTER_POST_SYSTEMS,
    ],
    registry: reg,
  });

  const rebuilding = buildExecutionGraph({
    id: REBUILDING_GRAPH_ID,
    nodes: [
      STATE_MACHINE_SYSTEM_ID,
      "transitionActivatorSystem",
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

  // Register the 4 core graphs as Modes per docs/modes-and-modules.md.
  // The mode `systems` list is what we built each ExecutionGraph from;
  // the graph itself is a derived value, regenerated from this list at
  // activation time. We keep registerGraph for backward compat during
  // the Phase 1→Phase 1b transition (StateMachineSystem still reads
  // activeGraph; the mode-driven path lands in Phase 1b).
  reg.registerMode({
    id: LOADING_GRAPH_ID,
    label: "Loading",
    tags: ["core"],
    systems: loading.nodes,
  });
  reg.registerMode({
    id: RUNNING_GRAPH_ID,
    label: "Running",
    tags: ["core"],
    systems: running.nodes,
  });
  reg.registerMode({
    id: REBUILDING_GRAPH_ID,
    label: "Rebuilding",
    tags: ["core"],
    systems: rebuilding.nodes,
  });
  reg.registerMode({
    id: BUILDER_GRAPH_ID,
    label: "Builder",
    tags: ["editor"],
    systems: builder.nodes,
  });

  return { loading, running, rebuilding, builder };
}
