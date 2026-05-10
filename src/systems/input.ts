import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { INPUT_BUFFER_ID, type InputBufferData } from "../buffers/input";
import { readPrimaryGamepad } from "../lib/input/gamepad";

export const INPUT_SYSTEM_ID = "inputSystem";

/**
 * Owns raw input device collection: DOM event listeners (keydown/up,
 * mousemove, pointerlock-change) feed a private accumulator; gamepad state is
 * polled per tick via `readPrimaryGamepad`. `execute()` copies both into
 * InputBuffer each tick. InputMapperSystem drains the mouse deltas downstream;
 * held keys + gamepad button names persist until release.
 *
 * Call `attachInputListeners(acc, opts)` once at app startup for keyboard +
 * mouse. Gamepad needs no attachment — `navigator.getGamepads()` is poll-only.
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
    description:
      "Drains accumulated keyboard + mouse + pointer-lock state into InputBuffer each tick, and polls navigator.getGamepads() for the primary Standard-mapping gamepad.",
    buffers: [{ id: INPUT_BUFFER_ID, access: "readwrite" }],
    execute: ({ buffer }) => {
      const input = buffer<InputBufferData>(INPUT_BUFFER_ID);
      const prev = readBuffer(input);
      const pad = readPrimaryGamepad();
      writeBuffer(input, (d) => {
        d.keys = new Set(acc.keys);
        d.mouseDx = prev.mouseDx + acc.mouseDx;
        d.mouseDy = prev.mouseDy + acc.mouseDy;
        d.pointerLocked = acc.pointerLocked;
        if (pad) {
          d.gamepadConnected = true;
          d.gamepadAxes = pad.axes;
          d.gamepadButtons = pad.buttons;
        } else {
          d.gamepadConnected = false;
          d.gamepadAxes = { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
          d.gamepadButtons = new Set();
        }
      });
      acc.mouseDx = 0;
      acc.mouseDy = 0;
    },
  };
}
