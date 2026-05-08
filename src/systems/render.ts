import * as THREE from "three";
import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { CAMERA_MOVEMENT_SYSTEM_ID } from "./cameraMovement";

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
    runsAfter: [CAMERA_MOVEMENT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const camData = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refs.threeCamera || !refs.renderer || !refs.scene) return;

      const c = refs.threeCamera;
      c.position.set(camData.pos[0], camData.pos[1], camData.pos[2]);
      c.quaternion.setFromEuler(new THREE.Euler(camData.pitch, camData.yaw, 0, "YXZ"));
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
