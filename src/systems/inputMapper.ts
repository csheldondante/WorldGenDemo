import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_BUFFER_ID, type InputBufferData } from "../buffers/input";
import {
  INPUT_MAP_BUFFER_ID,
  type InputMapBufferData,
  type ButtonState,
} from "../buffers/inputMap";
import { INPUT_SYSTEM_ID } from "./input";

export const INPUT_MAPPER_SYSTEM_ID = "inputMapperSystem";

/** Radians per pixel of mouse movement. */
const MOUSE_SENS = 0.0022;
/** Radians per second at full right-stick deflection. */
const RIGHT_STICK_YAW_SPEED = 3.0;
const RIGHT_STICK_PITCH_SPEED = 2.2;

/**
 * Binding table: device-state predicates per named action. Adding a new
 * action (sprint, interact, crouch, ...) means one row here + one
 * `ButtonState` field in InputMapBuffer.actions.
 *
 * Future: lift this into a data-driven `InputBindingsBuffer` for rebind UI.
 */
const BINDINGS: Record<keyof InputMapBufferData["actions"], {
  keys: readonly string[];
  gamepadButtons: readonly string[];
}> = {
  jump: { keys: ["Space"], gamepadButtons: ["GamepadA"] },
  toggleHud: { keys: ["KeyH"], gamepadButtons: ["GamepadBack"] },
  crouch: { keys: ["ControlLeft", "ControlRight"], gamepadButtons: ["GamepadB"] },
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function nextButtonState(isHeld: boolean, prev: ButtonState, dt: number): ButtonState {
  return {
    held: isHeld,
    pressed: isHeld && !prev.held,
    released: !isHeld && prev.held,
    heldSec: isHeld ? prev.heldSec + dt : 0,
  };
}

/**
 * Translates raw device state (InputBuffer) into device-agnostic semantic
 * input (InputMapBuffer). Owns:
 *
 * - Move-axis blending: keyboard WASD + left stick → clamped [-1, 1] vector.
 * - Look-delta unit conversion: mouse Δpx × MOUSE_SENS + right stick × speed × dt,
 *   both summed in radians/tick on the same axes.
 * - Edge detection for named actions via prev-state self-read of InputMapBuffer.
 * - Mouse-delta drain (writes InputBuffer.mouseDx/Dy back to 0 after read).
 *
 * Sole reader of raw `InputBuffer` for mapping purposes. Gameplay systems read
 * `InputMapBuffer` and never see device specifics.
 */
export function createInputMapperSystem(): SystemDescriptor {
  return {
    id: INPUT_MAPPER_SYSTEM_ID,
    description:
      "Translates raw InputBuffer (keys, mouse, gamepad) into device-agnostic InputMapBuffer (moveAxis, lookDelta, actions). Owns the binding table, blends device sources, computes button edges, and drains mouse deltas.",
    buffers: [
      { id: INPUT_BUFFER_ID, access: "readwrite" },
      { id: INPUT_MAP_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, INPUT_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const inputBuf = buffer<InputBufferData>(INPUT_BUFFER_ID);
      const imBuf = buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID);
      const input = readBuffer(inputBuf);
      const prevMap = readBuffer(imBuf);

      // Move axis: keyboard direction + left stick (Y inverted so stick-up = forward).
      // Per-axis clamp prevents stick + key sums exceeding unit deflection on a
      // single axis. We then scale the *vector* to unit length when its
      // magnitude exceeds 1 so diagonal input (W+D held → raw |v|=√2) isn't
      // faster than straight forward. Magnitudes under 1 (partial stick
      // deflection) are preserved.
      const keyDx = (input.keys.has("KeyD") ? 1 : 0) - (input.keys.has("KeyA") ? 1 : 0);
      const keyDy = (input.keys.has("KeyW") ? 1 : 0) - (input.keys.has("KeyS") ? 1 : 0);
      let moveX = clamp(keyDx + input.gamepadAxes.leftX, -1, 1);
      let moveY = clamp(keyDy + -input.gamepadAxes.leftY, -1, 1);
      const moveMag = Math.hypot(moveX, moveY);
      if (moveMag > 1) {
        moveX /= moveMag;
        moveY /= moveMag;
      }

      // Look delta: mouse delta (px × rad/px) + right stick (axis × rad/s × dt).
      // Negative signs match the existing "mouse right → yaw decreases" convention.
      const yawFromMouse = -input.mouseDx * MOUSE_SENS;
      const pitchFromMouse = -input.mouseDy * MOUSE_SENS;
      const yawFromStick = -input.gamepadAxes.rightX * RIGHT_STICK_YAW_SPEED * dt;
      const pitchFromStick = -input.gamepadAxes.rightY * RIGHT_STICK_PITCH_SPEED * dt;
      const lookDelta = {
        yaw: yawFromMouse + yawFromStick,
        pitch: pitchFromMouse + pitchFromStick,
      };

      // Edge-detected named actions via binding table.
      const jumpHeld =
        BINDINGS.jump.keys.some((k) => input.keys.has(k)) ||
        BINDINGS.jump.gamepadButtons.some((b) => input.gamepadButtons.has(b));
      const jump = nextButtonState(jumpHeld, prevMap.actions.jump, dt);
      const toggleHudHeld =
        BINDINGS.toggleHud.keys.some((k) => input.keys.has(k)) ||
        BINDINGS.toggleHud.gamepadButtons.some((b) => input.gamepadButtons.has(b));
      const toggleHud = nextButtonState(toggleHudHeld, prevMap.actions.toggleHud, dt);
      const crouchHeld =
        BINDINGS.crouch.keys.some((k) => input.keys.has(k)) ||
        BINDINGS.crouch.gamepadButtons.some((b) => input.gamepadButtons.has(b));
      const crouch = nextButtonState(crouchHeld, prevMap.actions.crouch, dt);

      writeBuffer(imBuf, (d) => {
        d.moveAxis = { x: moveX, y: moveY };
        d.lookDelta = lookDelta;
        d.actions = { jump, toggleHud, crouch };
      });

      // Drain mouse deltas after consumption.
      if (input.mouseDx !== 0 || input.mouseDy !== 0) {
        writeBuffer(inputBuf, (d) => {
          d.mouseDx = 0;
          d.mouseDy = 0;
        });
      }
    },
  };
}
