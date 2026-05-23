/**
 * OverlayVisibilitySystem — toggles a DOM element's `display` based
 * on the runtime's active mode. Replaces the prior imperative
 * `panel.style.display = ...` calls from the mode-switcher widget's
 * DOM event handlers. Tech-debt payoff 2026-05-23.
 *
 * Pattern: factory closes over the target element + the mode id
 * the element should be visible in. Each tick reads `activeMode`
 * from `StateMachineBuffer` and writes `display` accordingly. When
 * target is `null`, the system is a no-op (= production may register
 * before the DOM exists, headless tests may run without DOM).
 */

import { readBuffer } from "./buffer";
import type { SystemDescriptor } from "./system";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "./stateMachine";

export const OVERLAY_VISIBILITY_SYSTEM_ID = "overlayVisibilitySystem";

export interface OverlayVisibilityTarget {
  style: { display: string };
}

export interface OverlayVisibilityOptions {
  /** DOM element to toggle. `null` = no-op. */
  target: OverlayVisibilityTarget | null;
  /** Mode id at which the target becomes visible (= `display: block`).
   *  At any other activeMode, the target hides (= `display: none`). */
  showWhenActiveMode: string;
  /** CSS display value when shown. Defaults to "block". */
  shownDisplay?: string;
}

export function createOverlayVisibilitySystem(
  opts: OverlayVisibilityOptions,
): SystemDescriptor {
  const shown = opts.shownDisplay ?? "block";
  return {
    id: OVERLAY_VISIBILITY_SYSTEM_ID,
    description:
      "Toggles an overlay DOM element's display attribute based on the runtime's activeMode. Reads StateMachineBuffer; writes only to the target's CSS style.",
    buffers: [{ id: STATE_MACHINE_BUFFER_ID, access: "read" }],
    // Read AFTER SM has updated activeMode this tick (= so a
    // ModeSwitchRequested processed this tick is immediately visible).
    runsAfter: ["stateMachineSystem"],
    execute: ({ buffer }) => {
      if (!opts.target) return;
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      const next = sm.activeMode === opts.showWhenActiveMode ? shown : "none";
      if (opts.target.style.display !== next) {
        opts.target.style.display = next;
      }
    },
  };
}
