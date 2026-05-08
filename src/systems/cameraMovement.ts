import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { INPUT_BUFFER_ID, type InputBufferData } from "../buffers/input";
import { INPUT_SYSTEM_ID } from "./input";

export const CAMERA_MOVEMENT_SYSTEM_ID = "cameraMovementSystem";

const PITCH_LIMIT = Math.PI / 2 - 0.05;
const MOUSE_SENSITIVITY = 0.0022;
const BASE_SPEED = 14;
const BOOST = 2.4;

/**
 * Reads InputBuffer (keys + mouse deltas), writes CameraBuffer (pos + yaw + pitch).
 *
 * Forward derived from yaw and projected to the XZ plane: WASD are strictly
 * horizontal regardless of pitch. Space / Ctrl / KeyC handle vertical motion.
 *
 * Mouse deltas are *consumed*: after reading them, the system zeros mouseDx/mouseDy
 * in InputBuffer. InputSystem accumulates them between drains.
 */
export function createCameraMovementSystem(): SystemDescriptor {
  return {
    id: CAMERA_MOVEMENT_SYSTEM_ID,
    description: "Reads InputBuffer; updates CameraBuffer pos/yaw/pitch. WASD strictly horizontal; Space/Ctrl vertical.",
    buffers: [
      { id: INPUT_BUFFER_ID, access: "readwrite" }, // drains mouse deltas
      { id: CAMERA_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [INPUT_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const input = buffer<InputBufferData>(INPUT_BUFFER_ID);
      const camera = buffer<CameraBufferData>(CAMERA_BUFFER_ID);
      const inputData = readBuffer(input);
      const cam = readBuffer(camera);

      // Mouse-look: drain accumulated deltas
      let yaw = cam.yaw - inputData.mouseDx * MOUSE_SENSITIVITY;
      let pitch = cam.pitch - inputData.mouseDy * MOUSE_SENSITIVITY;
      if (pitch > PITCH_LIMIT) pitch = PITCH_LIMIT;
      if (pitch < -PITCH_LIMIT) pitch = -PITCH_LIMIT;

      // Yaw-only horizontal movement
      // forward = (-sin(yaw), 0, -cos(yaw)); right = (cos(yaw), 0, -sin(yaw))
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      const fwdX = -sy, fwdZ = -cy;
      const rightX = cy, rightZ = -sy;

      let dx = 0, dz = 0, dy = 0;
      const k = inputData.keys;
      if (k.has("KeyW")) { dx += fwdX; dz += fwdZ; }
      if (k.has("KeyS")) { dx -= fwdX; dz -= fwdZ; }
      if (k.has("KeyD")) { dx += rightX; dz += rightZ; }
      if (k.has("KeyA")) { dx -= rightX; dz -= rightZ; }
      if (k.has("Space")) dy += 1;
      if (k.has("KeyC") || k.has("ControlLeft") || k.has("ControlRight")) dy -= 1;

      const horizLen = Math.hypot(dx, dz);
      if (horizLen > 0) { dx /= horizLen; dz /= horizLen; }

      const boost = (k.has("ShiftLeft") || k.has("ShiftRight")) ? BOOST : 1;
      const speed = BASE_SPEED * boost * dt;

      const newPos: [number, number, number] = [
        cam.pos[0] + dx * speed,
        cam.pos[1] + dy * speed,
        cam.pos[2] + dz * speed,
      ];

      writeBuffer(camera, (d) => {
        d.yaw = yaw;
        d.pitch = pitch;
        d.pos = newPos;
      });
      // Drain consumed mouse deltas
      if (inputData.mouseDx !== 0 || inputData.mouseDy !== 0) {
        writeBuffer(input, (d) => { d.mouseDx = 0; d.mouseDy = 0; });
      }
    },
  };
}
