import * as THREE from "three";
import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { SPHERE_BODY_BUFFER_ID, type SphereBodyBufferData } from "../buffers/sphereBody";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
  type CharacterControllerComponent,
} from "../buffers/characterController";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { BODY_LEAN_SYSTEM_ID } from "./bodyLean";

export const CHARACTER_RENDER_SYNC_SYSTEM_ID = "characterRenderSyncSystem";

/**
 * Per-state mesh colors. Communicates the controller's FSM state at a glance:
 *   surfaceRun  — default orange (running on the ground / surface).
 *   surfaceSlide — yellow (slipping / crouched slide; less voluntary control).
 *   airborne    — light blue (in the air, no surface attachment).
 *   wallRun     — blue (reserved; lands with the wallRun state).
 *   climb       — purple (reserved; lands with the climb state).
 */
const STATE_COLOR: Record<CharacterControllerComponent["state"], number> = {
  surfaceRun: 0xff7a3a,
  surfaceSlide: 0xffd040,
  airborne: 0x80c0ff,
  // Pre-existing winged states get default-ish hues until they need distinct
  // visual identity. Wall-run + climb colors land with their respective states.
  wingLaunch: 0xb080ff,
  flap: 0xffa0a0,
  glide: 0xc0e0ff,
};

const DEFAULT_COLOR = 0xff7a3a;

export function createCharacterRenderSyncSystem(): SystemDescriptor {
  // Closure caches the mesh + its material per entity. Each entity owns its
  // material so the FSM-state color can be set independently per character.
  const meshes = new Map<number, { mesh: THREE.Mesh; material: THREE.MeshStandardMaterial }>();

  return {
    id: CHARACTER_RENDER_SYNC_SYSTEM_ID,
    description:
      "Mirrors entity Transform + SphereBody into Three.js meshes added to the active scene. Sets the per-character material color from the FSM state so the user can see surfaceRun / surfaceSlide / airborne / wallRun / climb at a glance.",
    buffers: [
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: SPHERE_BODY_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
    ],
    // After bodyLean too because bodyLean writes characterController (bodyUp*),
    // which we now read for the state color. bodyLean is the last writer of
    // CharacterControllerBuffer in the Running graph.
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID, BODY_LEAN_SYSTEM_ID],
    execute: ({ buffer }) => {
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const spheres = readBuffer(buffer<SphereBodyBufferData>(SPHERE_BODY_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refs.scene) return;

      for (const [id, body] of spheres.byEntity) {
        const t = transforms.byEntity.get(id);
        if (!t) continue;
        let entry = meshes.get(id);
        if (!entry) {
          const material = new THREE.MeshStandardMaterial({ color: DEFAULT_COLOR, roughness: 0.5, metalness: 0.0 });
          const geom = new THREE.SphereGeometry(body.radius, 24, 16);
          const mesh = new THREE.Mesh(geom, material);
          mesh.castShadow = false;
          mesh.frustumCulled = false;
          refs.scene.add(mesh);
          entry = { mesh, material };
          meshes.set(id, entry);
        }
        entry.mesh.position.set(t.position[0], t.position[1], t.position[2]);
        entry.mesh.rotation.y = t.yaw;
        const ctrl = cc.byEntity.get(id);
        const color = ctrl ? STATE_COLOR[ctrl.state] ?? DEFAULT_COLOR : DEFAULT_COLOR;
        entry.material.color.setHex(color);
      }
    },
  };
}
