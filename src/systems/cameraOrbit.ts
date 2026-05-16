import * as THREE from "three";
import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../buffers/inputMap";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { INPUT_MAPPER_SYSTEM_ID } from "./inputMapper";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";
import { CAMERA_PIVOT_SYSTEM_ID } from "./cameraPivot";

export const CAMERA_ORBIT_SYSTEM_ID = "cameraOrbitSystem";

/**
 * Third-person orbit camera. Reads InputMapBuffer.lookDelta + CameraBuffer.pivot,
 * writes CameraBuffer.target + the renderer-facing pos/yaw/pitch.
 *
 * Phase 1: uses the pre-refactor back-offset math (constant world height
 * above pivot, distance behind pivot derived from yaw/pitch via a YXZ
 * Euler) so all existing scenarios match their baselines bit-for-bit.
 * `target.yaw`/`target.pitch` are written then copied straight into the
 * renderer fields (no exponential chase). Phase 2 swaps in
 * spherical-around-pivot.up; Phase 3 adds the pitch cushion + smoothing.
 */
const PHASE1_FOLLOW_DISTANCE = 6;   // horizontal back-offset (m)
const PHASE1_FOLLOW_HEIGHT = 2.6;   // constant world-Y above pivot (m)
const PHASE1_PITCH_LIMIT = Math.PI / 2 - 0.05;

export function createCameraOrbitSystem(): SystemDescriptor {
  return {
    id: CAMERA_ORBIT_SYSTEM_ID,
    description:
      "Third-person orbit camera. Reads InputMapBuffer.lookDelta + CameraBuffer.pivot, writes CameraBuffer.target and the renderer-facing pos/yaw/pitch.",
    buffers: [
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, INPUT_MAPPER_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID, CAMERA_PIVOT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const cam = buffer<CameraBufferData>(CAMERA_BUFFER_ID);
      const c0 = readBuffer(cam);

      // Apply look-delta to target.yaw/pitch and clamp pitch.
      let targetYaw = c0.target.yaw + im.lookDelta.yaw;
      let targetPitch = c0.target.pitch + im.lookDelta.pitch;
      if (targetPitch > PHASE1_PITCH_LIMIT) targetPitch = PHASE1_PITCH_LIMIT;
      if (targetPitch < -PHASE1_PITCH_LIMIT) targetPitch = -PHASE1_PITCH_LIMIT;

      // Phase 1: instant chase — rendered yaw/pitch = target yaw/pitch.
      const yaw = targetYaw;
      const pitch = targetPitch;

      // Phase 1 position formula matches pre-refactor cameraFollow.ts:
      // camera = pivot + back-offset(yaw, pitch) * D + worldUp * height.
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      const pivotPos = c0.pivot.position;

      writeBuffer(cam, (c) => {
        c.target.yaw = targetYaw;
        c.target.pitch = targetPitch;
        c.yaw = yaw;
        c.pitch = pitch;
        c.pos = [
          pivotPos[0] - fwd.x * PHASE1_FOLLOW_DISTANCE,
          pivotPos[1] + PHASE1_FOLLOW_HEIGHT,
          pivotPos[2] - fwd.z * PHASE1_FOLLOW_DISTANCE,
        ];
      });
    },
  };
}
