import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../buffers/forceAccumulator";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID } from "./surfaceConstrainedVelocity";

export const VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID = "volumetricConstrainedVelocitySystem";

/**
 * Integration for airborne entities and any entity without a CharacterController.
 * Standard semi-implicit Euler in XYZ; no surface snap downstream. This is the path
 * for jumping, falling, projectiles, vehicles in airborne phase, etc.
 *
 * Iteration walks `VelocityBuffer.byEntity` (which is the universe of moving things)
 * rather than the character roster, then *excludes* entities flagged as
 * `surfaceConstrained` — those are integrated by `SurfaceConstrainedVelocitySystem`.
 * Non-character entities (no CC entry) fall through here by design.
 *
 * Runs after `SurfaceConstrainedVelocitySystem` to give a deterministic ordering on
 * the shared accumulator/velocity/transform buffers, even though the two systems
 * touch disjoint entity sets.
 */
export function createVolumetricConstrainedVelocitySystem(): SystemDescriptor {
  return {
    id: VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID,
    description:
      "Integrates airborne characters and non-character entities (any moving entity that is NOT locomotionMode === 'surfaceConstrained'). Semi-implicit Euler in XYZ. Runs after SurfaceConstrainedVelocitySystem to disambiguate shared-buffer ordering.",
    buffers: [
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_CONTROLLER_SYSTEM_ID, SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const accels = readBuffer(fa);

      writeBuffer(vBuf, (vels) => {
        writeBuffer(tBuf, (transforms) => {
          for (const [id, vel] of vels.byEntity) {
            const ctrl = cc.byEntity.get(id);
            // Skip surface-attached characters — they go through the surface integrator.
            if (ctrl && ctrl.locomotionMode === "surfaceConstrained") continue;
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

      // Clear accumulator for the entities we touched.
      writeBuffer(fa, (d) => {
        for (const [id, a] of d.byEntity) {
          const ctrl = cc.byEntity.get(id);
          if (ctrl && ctrl.locomotionMode === "surfaceConstrained") continue;
          a.accel[0] = 0; a.accel[1] = 0; a.accel[2] = 0;
        }
      });
    },
  };
}
