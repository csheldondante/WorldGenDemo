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
  type ControllerState,
} from "../buffers/characterController";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { CHARACTER_ORIENTATION_SYSTEM_ID } from "./characterOrientation";
import { BODY_LEAN_SYSTEM_ID } from "./bodyLean";

export const CHARACTER_RENDER_SYNC_SYSTEM_ID = "characterRenderSyncSystem";

/**
 * Visual color per FSM state. Lets us see at a glance which state the
 * controller picked this tick — debugging the threshold transitions is
 * much easier when the body changes hue on state change. Used by the
 * scenario harness and by interactive play.
 *
 * Exported so tests + future debug UIs can reference the same map.
 */
export const STATE_COLOR_HEX: Record<ControllerState, number> = {
  surfaceRun: 0x55cc55,   // green — normal locomotion
  surfaceSlide: 0xff8a3a, // orange — friction-dominated scramble (includes wallrun)
  climb: 0xaa55ff,        // purple — strong grip, low speed (Phase 2 wiring)
  airborne: 0x6699ff,     // blue — no surface
  wingLaunch: 0x66ccff,   // light blue — declared, not yet wired
  flap: 0x66ccff,         // light blue — declared, not yet wired
  glide: 0x33aaff,        // darker blue — declared, not yet wired
};

/** Fallback for non-character entities (no CharacterController entry). */
const DEFAULT_COLOR_HEX = 0xff7a3a;

/**
 * Mirror entity transforms into Three.js meshes for rendering. V1 just renders
 * each character entity as a colored sphere at its TransformBuffer position.
 *
 * Color is keyed by FSM state — see `STATE_COLOR_HEX`. Materials are
 * closure-cached one per state (shared across entities) so swapping just
 * reassigns `mesh.material`; no per-tick allocation.
 *
 * Lazily creates one mesh per entity on first sight; reuses thereafter.
 */
export function createCharacterRenderSyncSystem(): SystemDescriptor {
  // Closure caches the mesh per entity. Lifetime = world session.
  const meshes = new Map<number, THREE.Mesh>();
  const materialByState = new Map<ControllerState, THREE.MeshStandardMaterial>();
  const defaultMaterial = new THREE.MeshStandardMaterial({
    color: DEFAULT_COLOR_HEX,
    roughness: 0.5,
    metalness: 0.0,
  });
  for (const stateKey of Object.keys(STATE_COLOR_HEX) as ControllerState[]) {
    materialByState.set(
      stateKey,
      new THREE.MeshStandardMaterial({
        color: STATE_COLOR_HEX[stateKey],
        roughness: 0.5,
        metalness: 0.0,
      }),
    );
  }

  return {
    id: CHARACTER_RENDER_SYNC_SYSTEM_ID,
    description:
      "Mirrors entity Transform + SphereBody into Three.js meshes added to the active scene. Material color is keyed by CharacterController FSM state so debugging the threshold transitions is visual.",
    buffers: [
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: SPHERE_BODY_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
    ],
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      SURFACE_CONSTRAINT_SYSTEM_ID,
      CHARACTER_CONTROLLER_SYSTEM_ID,
      CHARACTER_ORIENTATION_SYSTEM_ID,
      BODY_LEAN_SYSTEM_ID,
    ],
    execute: ({ buffer }) => {
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const spheres = readBuffer(buffer<SphereBodyBufferData>(SPHERE_BODY_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refs.scene) return;

      for (const [id, body] of spheres.byEntity) {
        const t = transforms.byEntity.get(id);
        if (!t) continue;
        let mesh = meshes.get(id);
        if (!mesh) {
          const geom = new THREE.SphereGeometry(body.radius, 24, 16);
          mesh = new THREE.Mesh(geom, defaultMaterial);
          mesh.castShadow = false;
          mesh.frustumCulled = false;
          refs.scene.add(mesh);
          meshes.set(id, mesh);
        }
        mesh.position.set(t.position[0], t.position[1], t.position[2]);
        mesh.rotation.y = t.yaw;
        const ctrl = cc.byEntity.get(id);
        const mat = ctrl ? (materialByState.get(ctrl.state) ?? defaultMaterial) : defaultMaterial;
        if (mesh.material !== mat) {
          mesh.material = mat;
        }
      }
    },
  };
}
