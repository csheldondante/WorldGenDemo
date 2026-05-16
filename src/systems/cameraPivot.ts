import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";

export const CAMERA_PIVOT_SYSTEM_ID = "cameraPivotSystem";

/**
 * Writes `cameraBuffer.pivot` — the orbit centre + local frame the orbit
 * system rotates around.
 *
 * Phase 1: snap pivot.position to the followed character; leave pivot.up at
 * world +Y and pivot.fwd at world -Z. The split exists so Phase 2 can add
 * gravity sampling + parallel transport without touching CameraOrbit's
 * orbit math, and so the binary-search workflow can isolate "pivot drift"
 * from "orbit drift" when a scenario flags.
 */
export function createCameraPivotSystem(): SystemDescriptor {
  return {
    id: CAMERA_PIVOT_SYSTEM_ID,
    description:
      "Writes CameraBuffer.pivot — the orbit centre + local frame. Phase 1 snaps to followed character; Phase 2 will sample gravity for pivot.up and parallel-transport pivot.fwd.",
    buffers: [
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, SURFACE_CONSTRAINT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const cam = buffer<CameraBufferData>(CAMERA_BUFFER_ID);

      const targetId = cc.byEntity.keys().next().value as number | undefined;
      if (targetId === undefined) return;
      const t = transforms.byEntity.get(targetId);
      if (!t) return;

      writeBuffer(cam, (c) => {
        c.pivot.position = [t.position[0], t.position[1], t.position[2]];
        // Phase 1: leave up/fwd at defaults. Phase 2 swaps in gravity + parallel transport.
      });
    },
  };
}
