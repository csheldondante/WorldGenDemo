import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { INPUT_BUFFER_ID, type InputBufferData } from "../buffers/input";

export const INPUT_SYSTEM_ID = "inputSystem";

/**
 * Owns DOM event listeners (keydown/up, mousemove, pointerlock-change).
 *
 * Listeners write into a private accumulator. `execute()` copies the
 * accumulator into InputBuffer each tick. CameraMovementSystem drains the
 * mouse deltas after reading; held keys persist until keyup.
 *
 * Call `attachInputListeners(domTarget)` once at app startup.
 */

export interface InputAccumulator {
  keys: Set<string>;
  mouseDx: number;
  mouseDy: number;
  pointerLocked: boolean;
}

export function createAccumulator(): InputAccumulator {
  return { keys: new Set(), mouseDx: 0, mouseDy: 0, pointerLocked: false };
}

export interface InputAttachOptions {
  pointerLockTarget: HTMLElement;
  /** Called when the user clicks `pointerLockTarget`; default: requestPointerLock(). */
  onLockRequest?: () => void;
}

export function attachInputListeners(acc: InputAccumulator, opts: InputAttachOptions): () => void {
  const { pointerLockTarget } = opts;
  const onKeyDown = (e: KeyboardEvent) => {
    acc.keys.add(e.code);
    if (e.code === "Space") e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => acc.keys.delete(e.code);
  const onMouseMove = (e: MouseEvent) => {
    if (!acc.pointerLocked) return;
    acc.mouseDx += e.movementX;
    acc.mouseDy += e.movementY;
  };
  const onPLChange = () => { acc.pointerLocked = !!document.pointerLockElement; };
  const onClick = () => {
    if (opts.onLockRequest) opts.onLockRequest();
    else if (!document.pointerLockElement) pointerLockTarget.requestPointerLock();
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPLChange);
  pointerLockTarget.addEventListener("click", onClick);

  return () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPLChange);
    pointerLockTarget.removeEventListener("click", onClick);
  };
}

export function createInputSystem(acc: InputAccumulator): SystemDescriptor {
  return {
    id: INPUT_SYSTEM_ID,
    description: "Drains accumulated keyboard + mouse + pointer-lock state into InputBuffer each tick.",
    buffers: [{ id: INPUT_BUFFER_ID, access: "readwrite" }],
    execute: ({ buffer }) => {
      const input = buffer<InputBufferData>(INPUT_BUFFER_ID);
      const prev = readBuffer(input);
      writeBuffer(input, (d) => {
        d.keys = new Set(acc.keys);
        d.mouseDx = prev.mouseDx + acc.mouseDx;
        d.mouseDy = prev.mouseDy + acc.mouseDy;
        d.pointerLocked = acc.pointerLocked;
      });
      acc.mouseDx = 0;
      acc.mouseDy = 0;
    },
  };
}
