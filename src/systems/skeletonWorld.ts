import { readBuffer, writeBuffer } from "../runtime/buffer";
import { assertDev } from "../runtime/dev";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  RIG_DEFINITION_BUFFER_ID,
  type RigDefinitionBufferData,
} from "../buffers/rigDefinition";
import { SKELETON_BUFFER_ID, type SkeletonBufferData } from "../buffers/skeleton";
import { fromYaw, mul, rotate } from "../lib/math/quat";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";

export const SKELETON_WORLD_SYSTEM_ID = "skeletonWorldSystem";

/**
 * Forward kinematics: walk each entity's bone chain in parent-index order and
 * compose world transforms from (entity transform) × (per-bone local). Output
 * lives in SkeletonBuffer's per-bone worldPos/worldRot, ready for render and
 * Phase 1C foot IK.
 *
 * Invariant: rig topology requires `parent < self`, so a single pass suffices
 * — by the time we reach bone i, its parent's world transform is already
 * computed in the same iteration. assertDev catches any topology violation.
 */
export function createSkeletonWorldSystem(): SystemDescriptor {
  return {
    id: SKELETON_WORLD_SYSTEM_ID,
    description:
      "Forward-kinematics pass: composes per-bone world transforms from entity transform + per-bone local transforms. Walks each bone in parent-index order (parent < self invariant).",
    buffers: [
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: SKELETON_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const rigs = readBuffer(buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID));
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const skelBuf = buffer<SkeletonBufferData>(SKELETON_BUFFER_ID);
      const skel = readBuffer(skelBuf);
      if (skel.byEntity.size === 0) return;

      writeBuffer(skelBuf, (d) => {
        for (const [id, comp] of d.byEntity) {
          const rig = rigs.byId.get(comp.rigId);
          assertDev(!!rig, `SkeletonWorldSystem: missing rig "${comp.rigId}"`);
          if (!rig) continue;
          const t = transforms.byEntity.get(id);
          assertDev(!!t, `SkeletonWorldSystem: entity ${id} has skeleton but no transform`);
          if (!t) continue;

          const rootPos: [number, number, number] = [t.position[0], t.position[1], t.position[2]];
          const rootRot = fromYaw(t.yaw);

          for (let i = 0; i < rig.bones.length; i++) {
            const tmpl = rig.bones[i];
            assertDev(
              tmpl.parent < i,
              `SkeletonWorldSystem: rig "${comp.rigId}" bone ${i} ("${tmpl.name}") has parent ${tmpl.parent} >= self`,
            );
            const bone = comp.bones[i];
            const parentPos = tmpl.parent === -1 ? rootPos : comp.bones[tmpl.parent].worldPos;
            const parentRot = tmpl.parent === -1 ? rootRot : comp.bones[tmpl.parent].worldRot;

            const offset = rotate(parentRot, bone.localPos);
            bone.worldPos = [
              parentPos[0] + offset[0],
              parentPos[1] + offset[1],
              parentPos[2] + offset[2],
            ];
            bone.worldRot = mul(parentRot, bone.localRot);
          }
        }
      });
    },
  };
}
