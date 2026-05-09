import * as THREE from "three";
import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_BUFFER_ID, type InputBufferData } from "../buffers/input";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { INPUT_SYSTEM_ID } from "./input";
import { CHARACTER_INPUT_SYSTEM_ID } from "./characterInput";

export const CAMERA_FOLLOW_SYSTEM_ID = "cameraFollowSystem";

const FOLLOW_DISTANCE = 6;   // meters behind the player
const FOLLOW_HEIGHT = 2.6;   // meters above the player
const MOUSE_SENS = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.05;

/**
 * Third-person follow camera. Reads InputBuffer (mouse deltas) for free-look,
 * reads the player's TransformBuffer for the focus point, writes CameraBuffer
 * pos/yaw/pitch.
 *
 * Replaces the old fly-cam (CameraMovementSystem). When there's no character,
 * it leaves the camera as-is so Loading state still shows something.
 */
export function createCameraFollowSystem(): SystemDescriptor {
  return {
    id: CAMERA_FOLLOW_SYSTEM_ID,
    description:
      "Third-person follow camera. Reads InputBuffer (mouse), TransformBuffer (player), writes CameraBuffer pos/yaw/pitch behind+above the player.",
    buffers: [
      { id: INPUT_BUFFER_ID, access: "readwrite" }, // drains mouse deltas
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID, INPUT_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const inputBuf = buffer<InputBufferData>(INPUT_BUFFER_ID);
      const inputData = readBuffer(inputBuf);
      const cam = buffer<CameraBufferData>(CAMERA_BUFFER_ID);
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));

      // Update yaw/pitch from mouse deltas (consumed)
      writeBuffer(cam, (c) => {
        c.yaw -= inputData.mouseDx * MOUSE_SENS;
        c.pitch -= inputData.mouseDy * MOUSE_SENS;
        if (c.pitch > PITCH_LIMIT) c.pitch = PITCH_LIMIT;
        if (c.pitch < -PITCH_LIMIT) c.pitch = -PITCH_LIMIT;
      });
      if (inputData.mouseDx !== 0 || inputData.mouseDy !== 0) {
        writeBuffer(inputBuf, (d) => { d.mouseDx = 0; d.mouseDy = 0; });
      }

      // Pick the first character entity as the follow target.
      const targetId = cc.byEntity.keys().next().value as number | undefined;
      if (targetId === undefined) return;
      const t = transforms.byEntity.get(targetId);
      if (!t) return;

      // Camera forward in world XZ, derived from yaw on the Y-up system
      const c = readBuffer(cam);
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(c.pitch, c.yaw, 0, "YXZ"));
      writeBuffer(cam, (next) => {
        next.pos = [
          t.position[0] - fwd.x * FOLLOW_DISTANCE,
          t.position[1] + FOLLOW_HEIGHT,
          t.position[2] - fwd.z * FOLLOW_DISTANCE,
        ];
      });
    },
  };
}
