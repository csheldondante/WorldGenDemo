import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { runJFA } from "../../map/jfa";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../../buffers/renderRefs";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID } from "../../buffers/timing";
import { SPLIT_LAYERS_SYSTEM_ID } from "./splitLayers";
import { HEIGHTMAP_SYSTEM_ID } from "./heightmap";
import { STATE_MACHINE_SYSTEM_ID } from "../../runtime/stateMachine";
import { runOncePerRebuild } from "./common";

export const JFA_SYSTEM_ID = "jfaSystem";

export function createJfaSystem(): SystemDescriptor {
  const state = { lastGen: -1 };
  return {
    id: JFA_SYSTEM_ID,
    description: "GPU jump-flood per terrain → distance field + boundary gradient. Disposes prior result.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "readwrite" },
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [SPLIT_LAYERS_SYSTEM_ID, HEIGHTMAP_SYSTEM_ID, STATE_MACHINE_SYSTEM_ID],
    execute: (ctx) => {
      runOncePerRebuild({
        ctx,
        state,
        stageName: "jfa",
        body: () => {
          const world = ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID);
          const refs = readBuffer(ctx.buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
          const data = readBuffer(world);
          if (!data.terrainMap) return;
          if (!refs.renderer) return; // headless / test-time: skip GPU pass
          // Dispose previous JFA before computing the new one
          if (data.jfa) data.jfa.dispose();
          const jfa = runJFA(refs.renderer, data.terrainMap);
          writeBuffer(world, (d) => { d.jfa = jfa; });
        },
      });
    },
  };
}
