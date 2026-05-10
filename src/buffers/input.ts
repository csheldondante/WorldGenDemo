import { createBuffer, type Buffer } from "../runtime/buffer";

export interface InputBufferData {
  /** Currently held key codes (e.g. "KeyW", "ShiftLeft"). */
  keys: Set<string>;
  /** Accumulated mouse movement deltas since last drain. Drained by InputMapperSystem each tick. */
  mouseDx: number;
  mouseDy: number;
  pointerLocked: boolean;
  /** True iff a W3C "standard"-mapping gamepad is currently polled this tick. */
  gamepadConnected: boolean;
  /** Deadzoned analog stick axes, [-1, 1] per component. */
  gamepadAxes: { leftX: number; leftY: number; rightX: number; rightY: number };
  /** Pressed-button names this tick (e.g. "GamepadA"). Persists across ticks until release. */
  gamepadButtons: Set<string>;
}

export const INPUT_BUFFER_ID = "input";

export function createInputBuffer(): Buffer<InputBufferData> {
  return createBuffer<InputBufferData>({
    id: INPUT_BUFFER_ID,
    description:
      "Raw input device state: held keys, accumulated mouse deltas, pointer-lock state, gamepad axes + buttons. Mouse deltas are drained each tick by InputMapperSystem. No gameplay system should read this directly — read InputMapBuffer instead.",
    initial: {
      keys: new Set(),
      mouseDx: 0,
      mouseDy: 0,
      pointerLocked: false,
      gamepadConnected: false,
      gamepadAxes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
      gamepadButtons: new Set(),
    },
  });
}
