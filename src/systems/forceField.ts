import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../buffers/volumeField";
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../buffers/forceAccumulator";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { pickGravity, sortVolumesByPriority } from "../lib/math/gravityVolume";

export const FORCE_FIELD_SYSTEM_ID = "forceFieldSystem";

/**
 * Adds gravity into ForceAccumulatorBuffer for every character entity. For each
 * entity, picks the highest-priority gravity volume containing the entity's
 * world position; if no volume matches, uses the universal `VolumeFieldBuffer.gravity`.
 * Glider state multiplies the result by `profile.glideGravityMul`.
 *
 * Why all gravity flows through the accumulator (including the radial-volume case):
 * the CharacterControllerSystem's surface-frame solver decomposes the accumulator's
 * accel into tangent + normal components and absorbs the normal via the surface
 * reaction. Treating every gravity source as just-another-force keeps the model
 * uniform — no special cases for planets or centrifuges.
 */
export function createForceFieldSystem(): SystemDescriptor {
  return {
    id: FORCE_FIELD_SYSTEM_ID,
    description:
      "Per-entity gravity picker: reads VolumeFieldBuffer (universal gravity + scene-author volumes), TransformBuffer for entity positions, and CharacterControllerProfileBuffer for glideGravityMul. Writes the picked gravity vector into ForceAccumulatorBuffer for every character entity each tick.",
    buffers: [
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const vf = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);

      // Sort once per tick — typical scene has 0–3 volumes, so this is cheap.
      const sortedVolumes = vf.volumes.length > 0 ? sortVolumesByPriority(vf.volumes) : vf.volumes;

      writeBuffer(fa, (d) => {
        for (const [id, ctrl] of cc.byEntity) {
          const profile = profiles.byId.get(ctrl.profileId);
          const mul = ctrl.state === "glide" && profile ? profile.glideGravityMul : 1;
          const t = transforms.byEntity.get(id);
          const pos = t ? t.position : [0, 0, 0] as [number, number, number];
          const g = pickGravity(sortedVolumes, vf.gravity, pos);
          const accel = d.byEntity.get(id) ?? { accel: [0, 0, 0] as [number, number, number] };
          accel.accel[0] += g[0] * mul;
          accel.accel[1] += g[1] * mul;
          accel.accel[2] += g[2] * mul;
          d.byEntity.set(id, accel);
        }
      });
    },
  };
}
