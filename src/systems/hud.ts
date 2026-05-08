import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { TIMING_BUFFER_ID, type TimingBufferData } from "../buffers/timing";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../buffers/stateMachine";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../buffers/worldData";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { MINIMAP_SYSTEM_ID } from "./minimap";
import { CAMERA_MOVEMENT_SYSTEM_ID } from "./cameraMovement";
import { LOAD_SCENE_SYSTEM_ID } from "./loadScene";
import { PARSE_BITMAP_SYSTEM_ID } from "./pipeline/parseBitmap";
import { SPLIT_LAYERS_SYSTEM_ID } from "./pipeline/splitLayers";
import { JFA_SYSTEM_ID } from "./pipeline/jfa";
import { HEIGHTMAP_SYSTEM_ID } from "./pipeline/heightmap";
import { TERRAIN_MESH_SYSTEM_ID } from "./pipeline/terrainMesh";
import { ASSET_PLACEMENT_SYSTEM_ID } from "./pipeline/assetPlacement";

export const HUD_SYSTEM_ID = "hudSystem";

export function formatHud(args: {
  sceneName: string | null;
  state: string;
  stages: Record<string, number>;
  totalRebuildMs: number;
  warnings: number;
  cam: { pos: [number, number, number]; yaw: number };
}): string {
  const ms = (n: number) => (n ?? 0).toFixed(1).padStart(6);
  const yawDeg = (args.cam.yaw * 180 / Math.PI).toFixed(0);
  return [
    `scene: ${args.sceneName ?? "—"}    state: ${args.state}`,
    `parse:       ${ms(args.stages.parse ?? 0)} ms`,
    `split:       ${ms(args.stages.split ?? 0)} ms`,
    `jfa:         ${ms(args.stages.jfa ?? 0)} ms`,
    `heightmap:   ${ms(args.stages.heightmap ?? 0)} ms`,
    `terrainMesh: ${ms(args.stages.terrainMesh ?? 0)} ms`,
    `assets:      ${ms(args.stages.assetPlacement ?? 0)} ms`,
    `total:       ${ms(args.totalRebuildMs)} ms`,
    `warnings:    ${args.warnings}`,
    `cam: x=${args.cam.pos[0].toFixed(1)} z=${args.cam.pos[2].toFixed(1)} yaw=${yawDeg}°`,
  ].join("\n");
}

export function createHudSystem(): SystemDescriptor {
  return {
    id: HUD_SYSTEM_ID,
    description: "Renders timings, scene name, FSM state, and camera pos into the HUD overlay.",
    buffers: [
      { id: CAMERA_BUFFER_ID, access: "read" },
      { id: TIMING_BUFFER_ID, access: "read" },
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
    ],
    // Hud reads `timing`; every system that writes timing must run before us.
    // (LoadScene writes timing in the Loading graph; pipeline systems write
    // timing in the Rebuilding graph; both lists include systems that may
    // not be in every graph — graph builder silently drops out-of-graph edges.)
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      CAMERA_MOVEMENT_SYSTEM_ID,
      MINIMAP_SYSTEM_ID,
      LOAD_SCENE_SYSTEM_ID,
      PARSE_BITMAP_SYSTEM_ID,
      SPLIT_LAYERS_SYSTEM_ID,
      JFA_SYSTEM_ID,
      HEIGHTMAP_SYSTEM_ID,
      TERRAIN_MESH_SYSTEM_ID,
      ASSET_PLACEMENT_SYSTEM_ID,
    ],
    execute: ({ buffer }) => {
      const cam = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const t = readBuffer(buffer<TimingBufferData>(TIMING_BUFFER_ID));
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      const world = readBuffer(buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refs.hudEl) return;
      refs.hudEl.textContent = formatHud({
        sceneName: world.sceneName,
        state: sm.state,
        stages: t.stages,
        totalRebuildMs: t.totalRebuildMs,
        warnings: t.warnings.length,
        cam: { pos: cam.pos, yaw: cam.yaw },
      });
    },
  };
}
