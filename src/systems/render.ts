import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { CAMERA_ORBIT_SYSTEM_ID } from "./cameraOrbit";
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
    runsAfter: [CAMERA_ORBIT_SYSTEM_ID, CHARACTER_RENDER_SYNC_SYSTEM_ID, TERRAIN_MESH_SYSTEM_ID, ASSET_PLACEMENT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const camData = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refs.threeCamera || !refs.renderer || !refs.scene) return;

      const c = refs.threeCamera;
      c.position.set(camData.pos[0], camData.pos[1], camData.pos[2]);
      // Gravity-aligned camera orientation: lookAt the pivot with up = pivot.up.
      // three.js builds a full rotation matrix from (right, up, -forward), which
      // includes camera ROLL — necessary when pivot.up isn't world +Y (e.g.
      // Mario-Galaxy sphere / cylinder / torus worlds). On flat-Y gravity the
      // result is identical to the legacy setFromEuler(pitch, yaw, 0, "YXZ")
      // path. cam.yaw / cam.pitch are still maintained in the buffer for
      // downstream consumers (characterInput / characterOrientation), but the
      // renderer no longer depends on them.
      c.up.set(camData.pivot.up[0], camData.pivot.up[1], camData.pivot.up[2]);
      c.lookAt(camData.pivot.position[0], camData.pivot.position[1], camData.pivot.position[2]);
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
