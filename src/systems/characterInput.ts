import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../buffers/inputMap";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import {
  CHARACTER_INPUT_BUFFER_ID,
  type CharacterInputBufferData,
  type CharacterInputComponent,
} from "../buffers/characterInput";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../buffers/characterController";
import { INPUT_MAPPER_SYSTEM_ID } from "./inputMapper";

export const CHARACTER_INPUT_SYSTEM_ID = "characterInputSystem";

/**
 * Fans the semantic InputMapBuffer (move axis + jump action) out to per-entity
 * CharacterInputBuffer components, attaching the current camera yaw for
 * locomotion-frame projection by the controller. No device knowledge here —
 * raw input + binding live in InputMapperSystem.
 *
 * Body orientation (Transform.yaw) is managed by CharacterOrientationSystem
 * downstream; this system intentionally does not touch transforms.
 */
export function createCharacterInputSystem(): SystemDescriptor {
  return {
    id: CHARACTER_INPUT_SYSTEM_ID,
    description:
      "Reads semantic InputMapBuffer + CameraBuffer; writes per-character move axes, jump edges, and camera yaw into CharacterInputBuffer.",
    buffers: [
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_INPUT_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, INPUT_MAPPER_SYSTEM_ID],
    execute: ({ buffer }) => {
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const cam = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const ciBuf = buffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID);

      const moveX = im.moveAxis.x;
      const moveY = im.moveAxis.y;
      const { held: jumpHeld, pressed: jumpPressed, released: jumpReleased, heldSec: jumpHoldSec } = im.actions.jump;

      writeBuffer(ciBuf, (d) => {
        for (const id of ccBuf.data.byEntity.keys()) {
          const next: CharacterInputComponent = {
            moveX,
            moveY,
            jumpHeld,
            jumpPressed,
            jumpReleased,
            jumpHoldSec,
            cameraYaw: cam.yaw,
            cameraLookDir: [cam.lookDir[0], cam.lookDir[1], cam.lookDir[2]],
            cameraUp: [cam.pivot.up[0], cam.pivot.up[1], cam.pivot.up[2]],
          };
          d.byEntity.set(id, next);
        }
      });
    },
  };
}
