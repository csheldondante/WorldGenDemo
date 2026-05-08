import * as THREE from "three";
import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { buildTerrainMesh } from "../../map/terrainMesh";
import { buildProceduralTextures } from "../../terrain/textures";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../../buffers/renderRefs";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID } from "../../buffers/timing";
import { JFA_SYSTEM_ID } from "./jfa";
import { HEIGHTMAP_SYSTEM_ID } from "./heightmap";
import { STATE_MACHINE_SYSTEM_ID } from "../../runtime/stateMachine";
import { runOncePerRebuild } from "./common";

export const TERRAIN_MESH_SYSTEM_ID = "terrainMeshSystem";

function disposeTerrainMesh(scene: THREE.Scene, mesh: THREE.Mesh): void {
  scene.remove(mesh);
  mesh.geometry.dispose();
  const m = mesh.material as THREE.Material | THREE.Material[];
  if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
  else m.dispose();
}

export function createTerrainMeshSystem(): SystemDescriptor {
  const state = { lastGen: -1 };
  return {
    id: TERRAIN_MESH_SYSTEM_ID,
    description: "Builds the terrain mesh from heightmap + JFA splat inputs; replaces the prior mesh.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "readwrite" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [HEIGHTMAP_SYSTEM_ID, JFA_SYSTEM_ID, STATE_MACHINE_SYSTEM_ID],
    execute: (ctx) => {
      runOncePerRebuild({
        ctx,
        state,
        stageName: "terrainMesh",
        body: () => {
          const world = readBuffer(ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
          const refsBuf = ctx.buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID);
          const refs = readBuffer(refsBuf);
          if (!world.heightmap || !world.jfa || !refs.scene) return;

          if (refs.terrainMesh) disposeTerrainMesh(refs.scene, refs.terrainMesh);

          const textures = buildProceduralTextures();
          const mesh = buildTerrainMesh(world.heightmap, {
            distance: world.jfa.distance,
            gradient: world.jfa.gradient,
            channelTerrains: world.jfa.channelTerrains,
            textures,
          });
          refs.scene.add(mesh);
          writeBuffer(refsBuf, (d) => { d.terrainMesh = mesh; });
        },
      });
    },
  };
}
