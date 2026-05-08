import { createBuffer, type Buffer } from "../runtime/buffer";

export interface InputBufferData {
  /** Currently held key codes (e.g. "KeyW", "ShiftLeft"). */
  keys: Set<string>;
  /** Accumulated mouse movement deltas since last drain. Cleared by InputSystem each tick. */
  mouseDx: number;
  mouseDy: number;
  pointerLocked: boolean;
}

export const INPUT_BUFFER_ID = "input";

export function createInputBuffer(): Buffer<InputBufferData> {
  return createBuffer<InputBufferData>({
    id: INPUT_BUFFER_ID,
    description: "Held keys, accumulated mouse deltas, pointer-lock state. Cleared each tick by InputSystem.",
    initial: { keys: new Set(), mouseDx: 0, mouseDy: 0, pointerLocked: false },
  });
}
