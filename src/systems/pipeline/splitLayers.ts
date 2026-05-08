import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { splitLayers } from "../../map/splitLayers";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID } from "../../buffers/timing";
import { PARSE_BITMAP_SYSTEM_ID } from "./parseBitmap";
import { STATE_MACHINE_SYSTEM_ID } from "../../runtime/stateMachine";
import { runOncePerRebuild } from "./common";

export const SPLIT_LAYERS_SYSTEM_ID = "splitLayersSystem";

export function createSplitLayersSystem(): SystemDescriptor {
  const state = { lastGen: -1 };
  return {
    id: SPLIT_LAYERS_SYSTEM_ID,
    description: "Splits LabelMap into terrainMap + assetMap; majority-fills terrain under asset pixels.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "readwrite" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [PARSE_BITMAP_SYSTEM_ID, STATE_MACHINE_SYSTEM_ID],
    execute: (ctx) => {
      runOncePerRebuild({
        ctx,
        state,
        stageName: "split",
        body: () => {
          const world = ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID);
          const data = readBuffer(world);
          if (!data.labelMap) return;
          const split = splitLayers(data.labelMap);
          writeBuffer(world, (d) => {
            d.terrainMap = split.terrainMap;
            d.assetMap = split.assetMap;
          });
        },
      });
    },
  };
}
