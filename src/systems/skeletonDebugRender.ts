import * as THREE from "three";
import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import type { EntityId } from "../buffers/entity";
import {
  RIG_DEFINITION_BUFFER_ID,
  type RigDefinitionBufferData,
} from "../buffers/rigDefinition";
import { SKELETON_BUFFER_ID, type SkeletonBufferData } from "../buffers/skeleton";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { CHARACTER_RENDER_SYNC_SYSTEM_ID } from "./characterRenderSync";
import { SKELETON_WORLD_SYSTEM_ID } from "./skeletonWorld";
import { RENDER_SYSTEM_ID } from "./render";

export const SKELETON_DEBUG_RENDER_SYSTEM_ID = "skeletonDebugRenderSystem";

/**
 * Phase 1A debug overlay: draws each entity's skeleton as white line segments
 * (one line per non-root bone, parent.worldPos → bone.worldPos).
 *
 * Why a per-entity LineSegments cached in a closure: matches the
 * `CharacterRenderSyncSystem` pattern (lazy create on first sight, reuse
 * thereafter). Not InstancedMesh: single character in 1A, and instancing now
 * would couple to a per-archetype geometry shape that the eventual skinned-
 * mesh swap (Phase 1.5) doesn't need. The skinned-mesh renderer is a drop-in
 * replacement at this seam — same SkeletonBuffer.worldPos inputs, different
 * render system.
 *
 * Why depthTest: false on the material: this is a debug overlay; we want the
 * bones visible through the orange physics sphere.
 */
interface BoneRenderRefs {
  lineSegments: THREE.LineSegments;
  positionAttr: THREE.BufferAttribute;
  boneCount: number;
}

export function createSkeletonDebugRenderSystem(): SystemDescriptor {
  const refsByEntity = new Map<EntityId, BoneRenderRefs>();
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  });

  return {
    id: SKELETON_DEBUG_RENDER_SYSTEM_ID,
    description:
      "Debug-renders each entity's skeleton as white THREE.LineSegments (parent→child). Closure-cached one mesh per entity; depthTest disabled so bones show through the physics body. Swappable for a skinned-mesh renderer at Phase 1.5 without touching compute systems.",
    buffers: [
      { id: SKELETON_BUFFER_ID, access: "read" },
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
    ],
    runsAfter: [SKELETON_WORLD_SYSTEM_ID, CHARACTER_RENDER_SYNC_SYSTEM_ID],
    // RenderSystem reads renderRefs.scene; we mutate scene contents (line geometry)
    // before the draw, so we must precede it. MinimapSystem writes renderRefs and
    // runs after RenderSystem — adding it here closes the read/write hazard the
    // hazard checker enforces on shared buffers.
    runsBefore: [RENDER_SYSTEM_ID],
    execute: ({ buffer }) => {
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refs.scene) return;
      const rigs = readBuffer(buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID));
      const skel = readBuffer(buffer<SkeletonBufferData>(SKELETON_BUFFER_ID));

      for (const [id, comp] of skel.byEntity) {
        const rig = rigs.byId.get(comp.rigId);
        if (!rig) continue;

        // Lines per non-root bone.
        const lineCount = rig.bones.reduce((n, b) => (b.parent === -1 ? n : n + 1), 0);
        if (lineCount === 0) continue;

        let entry = refsByEntity.get(id);
        if (!entry || entry.boneCount !== rig.bones.length) {
          // Build (or rebuild if topology changed — defensive but rare).
          const positions = new Float32Array(lineCount * 2 * 3);
          const geometry = new THREE.BufferGeometry();
          const positionAttr = new THREE.BufferAttribute(positions, 3);
          positionAttr.setUsage(THREE.DynamicDrawUsage);
          geometry.setAttribute("position", positionAttr);
          const lineSegments = new THREE.LineSegments(geometry, material);
          lineSegments.frustumCulled = false;
          lineSegments.renderOrder = 999; // draw last so the overlay sits on top
          refs.scene.add(lineSegments);
          entry = { lineSegments, positionAttr, boneCount: rig.bones.length };
          refsByEntity.set(id, entry);
        }

        const arr = entry.positionAttr.array as Float32Array;
        let w = 0;
        for (let i = 0; i < rig.bones.length; i++) {
          const tmpl = rig.bones[i];
          if (tmpl.parent === -1) continue;
          const a = comp.bones[tmpl.parent].worldPos;
          const b = comp.bones[i].worldPos;
          arr[w++] = a[0]; arr[w++] = a[1]; arr[w++] = a[2];
          arr[w++] = b[0]; arr[w++] = b[1]; arr[w++] = b[2];
        }
        entry.positionAttr.needsUpdate = true;
      }
    },
  };
}
