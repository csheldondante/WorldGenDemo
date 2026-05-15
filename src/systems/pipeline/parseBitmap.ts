import { writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { parseBitmap, buildPalette } from "../../map/parseBitmap";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID } from "../../buffers/timing";
import { STATE_MACHINE_SYSTEM_ID } from "../../runtime/stateMachine";
import { runOncePerRebuild } from "./common";

export const PARSE_BITMAP_SYSTEM_ID = "parseBitmapSystem";

export function createParseBitmapSystem(): SystemDescriptor {
  const state = { lastGen: -1 };
  return {
    id: PARSE_BITMAP_SYSTEM_ID,
    description: "Parses the rebuild bitmap into a LabelMap; writes WorldDataBuffer.{labelMap, image, sceneName}.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "write" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID],
    execute: (ctx) => {
      runOncePerRebuild({
        ctx,
        state,
        stageName: "parse",
        body: (sm) => {
          const payload = sm.pendingRebuild!;
          // Parametric (gym) scenes are handled by parametricSurfaceSystem; skip the
          // bitmap path entirely so downstream stages (split/heightmap/...) cleanly
          // see labelMap=null and short-circuit.
          if (payload.scene.parametric) return;
          const palette = buildPalette(payload.scene); // throws on unknown id
          const labelMap = parseBitmap({
            width: payload.width,
            height: payload.height,
            pixels: payload.pixels,
            palette,
            tileSize: payload.scene.tileSize,
          });
          const world = ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID);
          writeBuffer(world, (d) => {
            d.image = payload.image;
            d.labelMap = labelMap;
            d.sceneName = payload.sceneName;
          });
        },
      });
    },
  };
}
