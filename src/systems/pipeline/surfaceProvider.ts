import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../../buffers/surfaceProvider";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID } from "../../buffers/timing";
import { HeightmapSurfaceProvider } from "../../world/surfaceProvider";
import { STATE_MACHINE_SYSTEM_ID } from "../../runtime/stateMachine";
import { HEIGHTMAP_SYSTEM_ID } from "./heightmap";
import { ASSET_PLACEMENT_SYSTEM_ID } from "./assetPlacement";
import { runOncePerRebuild } from "./common";

export const SURFACE_PROVIDER_SYSTEM_ID = "surfaceProviderSystem";

/**
 * After HeightmapSystem builds the per-scene heightmap, wrap it in a
 * SurfaceProvider and put it in SurfaceProviderBuffer so character systems
 * can sample / project against it.
 */
export function createSurfaceProviderSystem(): SystemDescriptor {
  const state = { lastGen: -1 };
  return {
    id: SURFACE_PROVIDER_SYSTEM_ID,
    description:
      "Wraps the per-scene heightmap in a HeightmapSurfaceProvider and writes it into SurfaceProviderBuffer for character systems to consume.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "write" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    // After HEIGHTMAP_SYSTEM_ID for the data; after ASSET_PLACEMENT for the
    // shared timing buffer ordering (every pipeline writer of `timing` must
    // chain to avoid write/write hazards).
    runsAfter: [HEIGHTMAP_SYSTEM_ID, ASSET_PLACEMENT_SYSTEM_ID, STATE_MACHINE_SYSTEM_ID],
    execute: (ctx) => {
      runOncePerRebuild({
        ctx,
        state,
        stageName: "surfaceProvider",
        body: () => {
          const world = readBuffer(ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
          if (!world.heightmap) return;
          const provider = new HeightmapSurfaceProvider("scene-heightmap", world.heightmap);
          writeBuffer(ctx.buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID), (d) => {
            d.heightmap = provider;
          });
        },
      });
    },
  };
}
