import * as THREE from "three";
import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { SPHERE_BODY_BUFFER_ID, type SphereBodyBufferData } from "../buffers/sphereBody";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";

export const CHARACTER_RENDER_SYNC_SYSTEM_ID = "characterRenderSyncSystem";

/**
 * Mirror entity transforms into Three.js meshes for rendering. V1 just renders
 * each character entity as a colored sphere at its TransformBuffer position.
 *
 * Lazily creates one mesh per entity on first sight; reuses thereafter.
 */
export function createCharacterRenderSyncSystem(): SystemDescriptor {
  // Closure caches the mesh per entity. Lifetime = world session.
  const meshes = new Map<number, THREE.Mesh>();
  const material = new THREE.MeshStandardMaterial({ color: 0xff7a3a, roughness: 0.5, metalness: 0.0 });

  return {
    id: CHARACTER_RENDER_SYNC_SYSTEM_ID,
    description:
      "Mirrors entity Transform + SphereBody into Three.js meshes added to the active scene. Visible-character sync; no logic.",
    buffers: [
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: SPHERE_BODY_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const spheres = readBuffer(buffer<SphereBodyBufferData>(SPHERE_BODY_BUFFER_ID));
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refs.scene) return;

      for (const [id, body] of spheres.byEntity) {
        const t = transforms.byEntity.get(id);
        if (!t) continue;
        let mesh = meshes.get(id);
        if (!mesh) {
          const geom = new THREE.SphereGeometry(body.radius, 24, 16);
          mesh = new THREE.Mesh(geom, material);
          mesh.castShadow = false;
          mesh.frustumCulled = false;
          refs.scene.add(mesh);
          meshes.set(id, mesh);
        }
        mesh.position.set(t.position[0], t.position[1], t.position[2]);
        mesh.rotation.y = t.yaw;
      }
    },
  };
}
