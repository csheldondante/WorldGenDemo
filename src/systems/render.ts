import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { CAMERA_FOLLOW_SYSTEM_ID } from "./cameraFollow";
import { CHARACTER_RENDER_SYNC_SYSTEM_ID } from "./characterRenderSync";
import { TERRAIN_MESH_SYSTEM_ID } from "./pipeline/terrainMesh";
import { ASSET_PLACEMENT_SYSTEM_ID } from "./pipeline/assetPlacement";

export const RENDER_SYSTEM_ID = "renderSystem";

/**
 * Mirrors CameraBuffer into THREE.PerspectiveCamera and renders the scene.
 *
 * No gameplay logic. Three.js is a render backend; the source of truth lives
 * in CameraBuffer. The mirror is one-way: buffer -> threeCamera.
 */
export function createRenderSystem(): SystemDescriptor {
  return {
    id: RENDER_SYSTEM_ID,
    description: "Mirrors CameraBuffer into THREE.PerspectiveCamera and calls renderer.render(scene, camera).",
    buffers: [
      { id: CAMERA_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
    ],
    // Renders LAST among per-frame systems; LATEST among Rebuilding pipeline
    // writers of renderRefs. Pipeline IDs that aren't in a graph are silently
    // dropped by the graph builder.
    runsAfter: [CAMERA_FOLLOW_SYSTEM_ID, CHARACTER_RENDER_SYNC_SYSTEM_ID, TERRAIN_MESH_SYSTEM_ID, ASSET_PLACEMENT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const camData = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refs.threeCamera || !refs.renderer || !refs.scene) return;

      const c = refs.threeCamera;
      c.position.set(camData.pos[0], camData.pos[1], camData.pos[2]);
      // CameraBuffer.quaternion is built by cameraFollow from gravity-up + yaw + pitch.
      // We mirror it directly instead of re-deriving from world-Y yaw/pitch so the
      // camera follows the gravity-tangent frame on curved gravity scenes.
      c.quaternion.set(camData.quaternion[0], camData.quaternion[1], camData.quaternion[2], camData.quaternion[3]);
      // Aspect / fov / near / far updates: only push when changed to avoid cost.
      if (c.fov !== camData.fov || c.aspect !== camData.aspect || c.near !== camData.near || c.far !== camData.far) {
        c.fov = camData.fov;
        c.aspect = camData.aspect;
        c.near = camData.near;
        c.far = camData.far;
        c.updateProjectionMatrix();
      }
      refs.renderer.render(refs.scene, c);
    },
  };
}
