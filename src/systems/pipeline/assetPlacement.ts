import * as THREE from "three";
import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { placeAssets } from "../../map/placeAssets";
import { registerBuiltinAssets } from "../../assets/register";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../../buffers/renderRefs";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../../buffers/camera";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID, type TimingBufferData } from "../../buffers/timing";
import { EVENT_BUFFER_ID } from "../../buffers/event";
import { STATE_MACHINE_SYSTEM_ID, type RuntimeEvent } from "../../runtime/stateMachine";
import { TERRAIN_MESH_SYSTEM_ID } from "./terrainMesh";
import { runOncePerRebuild } from "./common";

export const ASSET_PLACEMENT_SYSTEM_ID = "assetPlacementSystem";

function disposeAssetMeshes(scene: THREE.Scene, meshes: THREE.Object3D[]): void {
  for (const m of meshes) {
    scene.remove(m);
    if ((m as THREE.Mesh).geometry) (m as THREE.Mesh).geometry.dispose();
    const mat = (m as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
    else if (mat) mat.dispose();
  }
}

export function createAssetPlacementSystem(): SystemDescriptor {
  registerBuiltinAssets();
  const state = { lastGen: -1 };
  return {
    id: ASSET_PLACEMENT_SYSTEM_ID,
    description: "Connected components → footprints → InstancedMesh placements. Disposes prior meshes; emits WorldReady; sets initial camera spawn on first rebuild.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "readwrite" },
      { id: CAMERA_BUFFER_ID, access: "readwrite" }, // sets initial spawn
      { id: TIMING_BUFFER_ID, access: "write" },
      { id: EVENT_BUFFER_ID, access: "readwrite" }, // emits WorldReady
    ],
    runsAfter: [TERRAIN_MESH_SYSTEM_ID, STATE_MACHINE_SYSTEM_ID],
    execute: (ctx) => {
      const ran = runOncePerRebuild({
        ctx,
        state,
        stageName: "assetPlacement",
        body: () => {
          const world = readBuffer(ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
          const refsBuf = ctx.buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID);
          const refs = readBuffer(refsBuf);
          if (!world.assetMap || !world.terrainMap || !world.heightmap || !refs.scene) return;

          if (refs.assetMeshes.length) disposeAssetMeshes(refs.scene, refs.assetMeshes);

          const result = placeAssets({
            assetMap: world.assetMap,
            terrainMap: world.terrainMap,
            heightmap: world.heightmap,
            seed: 0xa5b1,
          });
          for (const m of result.meshes) refs.scene.add(m);
          writeBuffer(refsBuf, (d) => { d.assetMeshes = result.meshes; });

          // Surface warnings
          const timing = ctx.buffer<TimingBufferData>(TIMING_BUFFER_ID);
          writeBuffer(timing, (d) => { d.warnings = result.warnings.slice(); });
          if (result.warnings.length) console.warn("placement warnings:", result.warnings);

          // Initial camera spawn — only set on the *first* rebuild (state.lastGen was -1 before this body ran)
          if (state.lastGen === -1 && world.heightmap) {
            const worldDepth = world.heightmap.height * world.heightmap.tileSize;
            const startZ = worldDepth * 0.5 + 6;
            const cam = ctx.buffer<CameraBufferData>(CAMERA_BUFFER_ID);
            writeBuffer(cam, (d) => {
              d.pos = [0, 8, startZ];
              d.yaw = 0;
              d.pitch = -0.18;
            });
          }
        },
      });
      if (ran) {
        const events = ctx.buffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
        writeBuffer(events, (d) => { d.push({ type: "WorldReady" }); });
      }
    },
  };
}
