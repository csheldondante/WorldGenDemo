import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { CAMERA_FOLLOW_SYSTEM_ID } from "./cameraFollow";

export const GAIT_SYSTEM_ID = "gaitSystem";

const TAU = Math.PI * 2;

/**
 * Advances each character's `gaitPhase` based on its current horizontal speed.
 * The phase is a single shared clock; per-leg cycles are derived by adding
 * `LegSpec.gaitPhaseOffset` in FootIKSystem (left/right alternation for a
 * biped, four-phase trot for a quadruped, etc.).
 *
 * Step frequency model: `stepFreq = gaitBaseFreq + gaitSpeedFreq · speed`.
 * Stride length (in FootIK) = `speed / (2·stepFreq)`, so at rest stride is
 * zero — even though the clock keeps ticking at baseFreq the visible offset
 * vanishes. Below `gaitMinSpeed` we additionally freeze the phase so the
 * character truly stands still rather than slowly cycling.
 *
 * Per the user's "linear-controller mirror" calibration: the gait is a
 * timing signal, not a force. The actual foot positioning happens in
 * FootIKSystem; this system just owns the clock.
 */
export function createGaitSystem(): SystemDescriptor {
  return {
    id: GAIT_SYSTEM_ID,
    description:
      "Per-character gait clock advancer. Reads VelocityBuffer + CharacterControllerProfile (gaitBaseFreq, gaitSpeedFreq, gaitMinSpeed); writes CharacterController.gaitPhase. Frozen below minSpeed.",
    buffers: [
      { id: VELOCITY_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
    ],
    // cameraFollow reads characterController and runs earlier in the graph;
    // make the ordering explicit so the hazard checker is satisfied.
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID, CAMERA_FOLLOW_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const vels = readBuffer(buffer<VelocityBufferData>(VELOCITY_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);

      writeBuffer(ccBuf, (cc) => {
        for (const [id, ctrl] of cc.byEntity) {
          const profile = profiles.byId.get(ctrl.profileId);
          if (!profile) continue;
          const v = vels.byEntity.get(id);
          if (!v) continue;
          const speed = Math.hypot(v.linear[0], v.linear[2]);
          if (speed < profile.gaitMinSpeed) continue;
          const stepFreq = profile.gaitBaseFreq + profile.gaitSpeedFreq * speed;
          ctrl.gaitPhase = (ctrl.gaitPhase + TAU * stepFreq * dt) % TAU;
        }
      });
    },
  };
}
