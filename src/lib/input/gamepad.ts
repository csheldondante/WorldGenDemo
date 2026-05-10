/**
 * W3C Standard Gamepad helpers. Pure data in, pure data out.
 *
 * `readPrimaryGamepad` is the only function that touches `navigator`; the rest
 * are testable with a hand-built Gamepad-shaped object. No `three`, no
 * runtime/buffers/systems imports — this stays runtime-agnostic per
 * `src/lib/CLAUDE.md`.
 */

/**
 * W3C Standard Gamepad button-index → name table.
 * https://w3c.github.io/gamepad/#remapping
 *
 * Names follow the existing string-id convention for `InputBuffer.keys`
 * ("KeyW", "Space") — gamepad entries are prefixed `Gamepad...` so they don't
 * collide with keyboard codes.
 */
export const STANDARD_BUTTON_NAMES: readonly string[] = [
  "GamepadA",          // 0 — bottom face button (A on Xbox, X on PlayStation)
  "GamepadB",          // 1 — right face button (B on Xbox, O on PlayStation)
  "GamepadX",          // 2 — left face button (X on Xbox, Square on PlayStation)
  "GamepadY",          // 3 — top face button (Y on Xbox, Triangle on PlayStation)
  "GamepadLB",         // 4 — left shoulder
  "GamepadRB",         // 5 — right shoulder
  "GamepadLT",         // 6 — left trigger (analog, exposed as discrete here)
  "GamepadRT",         // 7 — right trigger (analog, exposed as discrete here)
  "GamepadBack",       // 8 — back / view / select
  "GamepadStart",      // 9 — start / menu
  "GamepadLS",         // 10 — left stick click
  "GamepadRS",         // 11 — right stick click
  "GamepadDpadUp",     // 12
  "GamepadDpadDown",   // 13
  "GamepadDpadLeft",   // 14
  "GamepadDpadRight",  // 15
  "GamepadHome",       // 16 — Xbox / PS / Home button
];

export interface GamepadAxes {
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
}

export interface GamepadSnapshot {
  axes: GamepadAxes;
  buttons: Set<string>;
}

/**
 * Radial deadzone applied to a stick (x, y) pair. If the magnitude is below
 * `dz`, returns {0, 0}. Otherwise rescales the remainder to [0, 1] over
 * [dz, 1] so input is continuous across the deadzone boundary.
 */
export function applyRadialDeadzone(
  x: number,
  y: number,
  dz: number,
): { x: number; y: number } {
  const mag = Math.hypot(x, y);
  if (mag < dz) return { x: 0, y: 0 };
  const scaled = (mag - dz) / (1 - dz);
  const clamped = scaled > 1 ? 1 : scaled;
  const inv = clamped / mag;
  return { x: x * inv, y: y * inv };
}

/**
 * Pure: takes a `Gamepad` (Web Gamepad API shape), returns deadzoned axes +
 * pressed-button set. `deadzone` is per-stick radial.
 */
export function snapshotGamepad(pad: Gamepad, deadzone = 0.18): GamepadSnapshot {
  const left = applyRadialDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, deadzone);
  const right = applyRadialDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, deadzone);
  const buttons = new Set<string>();
  for (let i = 0; i < pad.buttons.length && i < STANDARD_BUTTON_NAMES.length; i++) {
    if (pad.buttons[i]?.pressed) buttons.add(STANDARD_BUTTON_NAMES[i]);
  }
  return {
    axes: { leftX: left.x, leftY: left.y, rightX: right.x, rightY: right.y },
    buttons,
  };
}

/**
 * Wrapper that polls `navigator.getGamepads()` and returns a snapshot of the
 * first Standard-mapping gamepad, or `null` if none is connected. Non-standard
 * mappings are ignored — we can't trust the button indices.
 */
export function readPrimaryGamepad(deadzone = 0.18): GamepadSnapshot | null {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  for (const pad of pads) {
    if (pad && pad.connected && pad.mapping === "standard") {
      return snapshotGamepad(pad, deadzone);
    }
  }
  return null;
}
