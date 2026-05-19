import { createBuffer, type Buffer } from "../runtime/buffer";

/**
 * Edge-detected button state for a named action. `pressed`/`released` are
 * one-tick edges; `held` is steady-state; `heldSec` accumulates time held and
 * resets on release.
 */
export interface ButtonState {
  held: boolean;
  pressed: boolean;
  released: boolean;
  heldSec: number;
}

export function emptyButtonState(): ButtonState {
  return { held: false, pressed: false, released: false, heldSec: 0 };
}

/**
 * Device-agnostic semantic input. Written by InputMapperSystem from InputBuffer
 * (raw devices). All gameplay consumers (CharacterInputSystem,
 * CameraFollowSystem, future) read this — never InputBuffer directly. Adding
 * a new device routes through the mapper; adding a new action means a new
 * `ButtonState` field here + a binding row in the mapper.
 *
 * Units:
 * - `moveAxis`: normalized [-1, 1] per component, clamped after blend.
 * - `lookDelta`: radians accumulated *this tick*. Source-agnostic — both
 *   mouse delta (px × sens) and right-stick (axis × rad/s × dt) sum here.
 *   Consumers add it to yaw/pitch directly; no further sensitivity needed.
 */
export interface InputMapBufferData {
  moveAxis: { x: number; y: number };
  lookDelta: { yaw: number; pitch: number };
  actions: {
    jump: ButtonState;
    toggleHud: ButtonState;
    /** Toggle the in-game profile editor panel. */
    toggleProfileEditor: ButtonState;
    /** Cycle the edited entity's profileId to the previous profile in the buffer. */
    cycleProfilePrev: ButtonState;
    /** Cycle the edited entity's profileId to the next profile in the buffer. */
    cycleProfileNext: ButtonState;
    /** Clone the edited entity's current profile to a new id and switch to it. */
    cloneProfile: ButtonState;
  };
}

export const INPUT_MAP_BUFFER_ID = "inputMap";

export function createInputMapBuffer(): Buffer<InputMapBufferData> {
  return createBuffer<InputMapBufferData>({
    id: INPUT_MAP_BUFFER_ID,
    description:
      "Device-agnostic semantic input: clamped move axis, accumulated look delta (radians/tick), edge-detected named actions. Written by InputMapperSystem; read by gameplay consumers (CharacterInputSystem, CameraFollowSystem). No gameplay system should read InputBuffer directly — read this instead.",
    initial: {
      moveAxis: { x: 0, y: 0 },
      lookDelta: { yaw: 0, pitch: 0 },
      actions: {
        jump: emptyButtonState(),
        toggleHud: emptyButtonState(),
        toggleProfileEditor: emptyButtonState(),
        cycleProfilePrev: emptyButtonState(),
        cycleProfileNext: emptyButtonState(),
        cloneProfile: emptyButtonState(),
      },
    },
  });
}
