import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../buffers/volumeField";
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../buffers/forceAccumulator";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";

export const FORCE_FIELD_SYSTEM_ID = "forceFieldSystem";

/**
 * Adds gravity into ForceAccumulatorBuffer for ALL character entities.
 * Surface-attached characters get gravity too — the CharacterControllerSystem's
 * surface-frame solver decomposes the accumulator's existing accel and absorbs
 * the normal component via the surface reaction. Treating gravity as just
 * another force keeps the model uniform and lets future weird-gravity
 * mechanics (low-grav zones, anti-grav fields) compose naturally.
 *
 * Gliders get a reduced gravity multiplier from their profile.
 */
export function createForceFieldSystem(): SystemDescriptor {
  return {
    id: FORCE_FIELD_SYSTEM_ID,
    description:
      "Reads VolumeFieldBuffer.gravity, accumulates gravity into ForceAccumulatorBuffer for every character entity (glide multiplier when state==glide). Surface-attached characters absorb the normal component via their controller; gravity-tangent remains and influences uphill/downhill behavior.",
    buffers: [
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const vf = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);

      writeBuffer(fa, (d) => {
        for (const [id, ctrl] of cc.byEntity) {
          const profile = profiles.byId.get(ctrl.profileId);
          const mul = ctrl.state === "glide" && profile ? profile.glideGravityMul : 1;
          const accel = d.byEntity.get(id) ?? { accel: [0, 0, 0] as [number, number, number] };
          accel.accel[0] += vf.gravity[0] * mul;
          accel.accel[1] += vf.gravity[1] * mul;
          accel.accel[2] += vf.gravity[2] * mul;
          d.byEntity.set(id, accel);
        }
      });
    },
  };
}
