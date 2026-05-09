import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_BUFFER_ID, type InputBufferData } from "../buffers/input";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import {
  CHARACTER_INPUT_BUFFER_ID,
  type CharacterInputBufferData,
  type CharacterInputComponent,
} from "../buffers/characterInput";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import { INPUT_SYSTEM_ID } from "./input";

export const CHARACTER_INPUT_SYSTEM_ID = "characterInputSystem";

/**
 * Translates raw keyboard state (InputBuffer) + camera yaw into per-character
 * normalized move axes and jump edges. Edge detection uses the `jumpHeldLastTick`
 * flag on CharacterControllerBuffer (stored there because that buffer's
 * lifetime matches the player; InputBuffer is global and shared).
 */
export function createCharacterInputSystem(): SystemDescriptor {
  return {
    id: CHARACTER_INPUT_SYSTEM_ID,
    description:
      "Reads raw InputBuffer + CameraBuffer; writes per-character normalized move axes and jump edges into CharacterInputBuffer.",
    buffers: [
      { id: INPUT_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: CHARACTER_INPUT_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, INPUT_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const input = readBuffer(buffer<InputBufferData>(INPUT_BUFFER_ID));
      const cam = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const ciBuf = buffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID);

      const cc = readBuffer(ccBuf);
      // Compute axes once — same input for every character (single-player, V1)
      const moveX = (input.keys.has("KeyD") ? 1 : 0) - (input.keys.has("KeyA") ? 1 : 0);
      const moveY = (input.keys.has("KeyW") ? 1 : 0) - (input.keys.has("KeyS") ? 1 : 0);
      const jumpHeld = input.keys.has("Space");

      writeBuffer(ciBuf, (d) => {
        for (const id of ccBuf.data.byEntity.keys()) {
          const prev = d.byEntity.get(id);
          const wasHeld = cc.byEntity.get(id)?.jumpHeldLastTick ?? false;
          const next: CharacterInputComponent = {
            moveX,
            moveY,
            jumpHeld,
            jumpPressed: jumpHeld && !wasHeld,
            jumpReleased: !jumpHeld && wasHeld,
            jumpHoldSec: jumpHeld ? (prev?.jumpHoldSec ?? 0) + dt : 0,
            cameraYaw: cam.yaw,
          };
          d.byEntity.set(id, next);
        }
      });
      writeBuffer(ccBuf, (d) => {
        for (const [id, comp] of d.byEntity) {
          comp.jumpHeldLastTick = jumpHeld;
          d.byEntity.set(id, comp);
        }
      });
    },
  };
}
