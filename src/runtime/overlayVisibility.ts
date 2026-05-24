/**
 * OverlayVisibilitySystem — toggles DOM element `display` based on
 * the runtime's active mode. One registered instance can manage
 * multiple panels (each shown when its bound modeId is active).
 *
 * Pattern: factory closes over a list of (target, modeId) bindings.
 * Each tick reads `activeMode` from `StateMachineBuffer` and sets
 * each bound target's display: shown when its modeId matches active,
 * hidden otherwise. Targets with `null` style are no-ops (= test
 * stubs without `style` field).
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

export interface OverlayBinding {
  /** Mode id at which `target` becomes visible. */
  modeId: string;
  /** DOM element to toggle. `null` = no-op for this binding. */
  target: OverlayVisibilityTarget | null;
  /** CSS display value when shown. Defaults to "block". */
  shownDisplay?: string;
}

export interface OverlayVisibilityOptions {
  /** Either a single binding (= pre-existing single-target API) or
   *  multiple bindings (each panel shown when its mode is active).
   *  Mixed usage: omitted parameters use a single legacy binding. */
  bindings?: OverlayBinding[];
  /** Single-target API (legacy compat). If `bindings` is also set,
   *  this binding is appended to it. */
  target?: OverlayVisibilityTarget | null;
  showWhenActiveMode?: string;
  shownDisplay?: string;
}

export function createOverlayVisibilitySystem(
  opts: OverlayVisibilityOptions,
): SystemDescriptor {
  const all: OverlayBinding[] = opts.bindings ? [...opts.bindings] : [];
  if (opts.showWhenActiveMode !== undefined) {
    all.push({
      modeId: opts.showWhenActiveMode,
      target: opts.target ?? null,
      shownDisplay: opts.shownDisplay,
    });
  }
  return {
    id: OVERLAY_VISIBILITY_SYSTEM_ID,
    description:
      "Toggles one or more overlay DOM elements' display attribute based on the runtime's activeMode. Reads StateMachineBuffer; writes only to the targets' CSS style.",
    buffers: [{ id: STATE_MACHINE_BUFFER_ID, access: "read" }],
    runsAfter: ["stateMachineSystem"],
    execute: ({ buffer }) => {
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      for (const b of all) {
        if (!b.target) continue;
        const next = sm.activeMode === b.modeId ? (b.shownDisplay ?? "block") : "none";
        if (b.target.style.display !== next) {
          b.target.style.display = next;
        }
      }
    },
  };
}
