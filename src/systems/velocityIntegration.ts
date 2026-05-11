import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../buffers/forceAccumulator";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";

export const VELOCITY_INTEGRATION_SYSTEM_ID = "velocityIntegrationSystem";

/**
 * Apply accumulated accelerations to velocity, advance position by velocity,
 * clear the accumulator. Standard semi-implicit Euler.
 */
export function createVelocityIntegrationSystem(): SystemDescriptor {
  return {
    id: VELOCITY_INTEGRATION_SYSTEM_ID,
    description:
      "Semi-implicit Euler integration: v += a·dt; pos += v·dt. Clears the force accumulator after.",
    buffers: [
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_CONTROLLER_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const accels = readBuffer(fa);

      writeBuffer(vBuf, (vels) => {
        writeBuffer(tBuf, (transforms) => {
          for (const [id, vel] of vels.byEntity) {
            // Snapshot pre-integration velocity for downstream accel derivation
            // (chain dynamics, hit reactions, future ragdoll triggers).
            vel.prevLinear[0] = vel.linear[0];
            vel.prevLinear[1] = vel.linear[1];
            vel.prevLinear[2] = vel.linear[2];
            const a = accels.byEntity.get(id);
            if (a) {
              vel.linear[0] += a.accel[0] * dt;
              vel.linear[1] += a.accel[1] * dt;
              vel.linear[2] += a.accel[2] * dt;
            }
            const t = transforms.byEntity.get(id);
            if (t) {
              t.position[0] += vel.linear[0] * dt;
              t.position[1] += vel.linear[1] * dt;
              t.position[2] += vel.linear[2] * dt;
              transforms.byEntity.set(id, t);
            }
            vels.byEntity.set(id, vel);
          }
        });
      });

      // Clear accumulator
      writeBuffer(fa, (d) => {
        for (const a of d.byEntity.values()) {
          a.accel[0] = 0; a.accel[1] = 0; a.accel[2] = 0;
        }
      });
    },
  };
}
