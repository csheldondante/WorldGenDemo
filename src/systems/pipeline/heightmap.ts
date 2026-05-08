import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { buildHeightmap } from "../../map/heightmap";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID } from "../../buffers/timing";
import { SPLIT_LAYERS_SYSTEM_ID } from "./splitLayers";
import { STATE_MACHINE_SYSTEM_ID } from "../../runtime/stateMachine";
import { runOncePerRebuild } from "./common";

export const HEIGHTMAP_SYSTEM_ID = "heightmapSystem";

export function createHeightmapSystem(): SystemDescriptor {
  const state = { lastGen: -1 };
  return {
    id: HEIGHTMAP_SYSTEM_ID,
    description: "Builds a Float32 heightmap from terrainMap (per-pixel elevation + small blur + jitter).",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "readwrite" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [SPLIT_LAYERS_SYSTEM_ID, STATE_MACHINE_SYSTEM_ID],
    execute: (ctx) => {
      runOncePerRebuild({
        ctx,
        state,
        stageName: "heightmap",
        body: () => {
          const world = ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID);
          const data = readBuffer(world);
          if (!data.terrainMap) return;
          const heightmap = buildHeightmap(data.terrainMap, { blurPasses: 2, jitter: 0.04, seed: 1 });
          writeBuffer(world, (d) => { d.heightmap = heightmap; });
        },
      });
    },
  };
}
