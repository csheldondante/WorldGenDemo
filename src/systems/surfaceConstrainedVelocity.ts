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

export const SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID = "surfaceConstrainedVelocitySystem";

/**
 * Integration for surface-attached characters. In B.2 this is still semi-implicit Euler
 * in XYZ — same math as the old `velocityIntegrationSystem`, just filtered to entities
 * with `locomotionMode === "surfaceConstrained"`. `SurfaceConstraintSystem` snaps the
 * position back to the surface immediately after.
 *
 * B.3 will replace the body of this system with UV-space integration (so the snap step
 * becomes unnecessary). For B.2 it's a pure refactor — the controller still produces
 * world-space accelerations, we still integrate in world space, and the snap still
 * runs downstream.
 *
 * Splitting the previous combined integration is what enables B.3: we change THIS
 * system's math without touching the volumetric path.
 */
export function createSurfaceConstrainedVelocitySystem(): SystemDescriptor {
  return {
    id: SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID,
    description:
      "Integrates surface-attached characters (locomotionMode === 'surfaceConstrained'). B.2 implementation: XYZ semi-implicit Euler — same code path as the prior combined velocityIntegrationSystem. B.3 will switch this to UV-space integration so the snap step in SurfaceConstraintSystem disappears.",
    buffers: [
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_CONTROLLER_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const accels = readBuffer(fa);

      writeBuffer(vBuf, (vels) => {
        writeBuffer(tBuf, (transforms) => {
          for (const [id, ctrl] of cc.byEntity) {
            if (ctrl.locomotionMode !== "surfaceConstrained") continue;
            const vel = vels.byEntity.get(id);
            if (!vel) continue;
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

      // Clear accumulator only for entities we touched. The volumetric system clears
      // its own. (Non-character entities have accumulator entries cleared by the
      // volumetric system.)
      writeBuffer(fa, (d) => {
        for (const [id, ctrl] of cc.byEntity) {
          if (ctrl.locomotionMode !== "surfaceConstrained") continue;
          const a = d.byEntity.get(id);
          if (a) { a.accel[0] = 0; a.accel[1] = 0; a.accel[2] = 0; }
        }
      });
    },
  };
}
