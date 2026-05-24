/**
 * PanelVisibilitySystem — toggles a CSS class on one of several DOM
 * elements based on the runtime's active mode. Sibling of
 * OverlayVisibilitySystem (= same shape, different mechanism: classes
 * instead of style.display).
 *
 * Used for the .world / .builder top-level panels whose CSS uses
 * `.active` for visibility. The dropdown handler emits the
 * mode-change event; this system applies the class toggle on the
 * next tick. No DOM mutation from event handlers.
 *
 * Per [[worldgen-demo-dod-editor-and-composition-principles]]:
 * "many simple systems that can be composed". This is the
 * class-toggle sibling to the display-toggle in OverlayVisibility.
 */

import { readBuffer } from "./buffer";
import type { SystemDescriptor } from "./system";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "./stateMachine";

export const PANEL_VISIBILITY_SYSTEM_ID = "panelVisibilitySystem";

export interface PanelClassTarget {
  classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean };
}

export interface PanelBinding {
  /** DOM panel to toggle. `null` skips (= production may register
   *  before DOM exists, headless tests may run without DOM). */
  panel: PanelClassTarget | null;
  /** Class name to add when this panel is active. Default "active". */
  activeClass?: string;
  /** Predicate over the current activeMode — true ⇒ this panel is
   *  active and gets the class. Multiple bindings can match (rare);
   *  each runs independently. */
  isActiveFor: (activeMode: string) => boolean;
}

export interface PanelVisibilityOptions {
  bindings: PanelBinding[];
}

export function createPanelVisibilitySystem(
  opts: PanelVisibilityOptions,
): SystemDescriptor {
  return {
    id: PANEL_VISIBILITY_SYSTEM_ID,
    description:
      "Toggles CSS classes on top-level DOM panels based on the runtime's activeMode. Reads StateMachineBuffer; writes only to target panels' classList.",
    buffers: [{ id: STATE_MACHINE_BUFFER_ID, access: "read" }],
    runsAfter: ["stateMachineSystem"],
    execute: ({ buffer }) => {
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      for (const b of opts.bindings) {
        if (!b.panel) continue;
        const cls = b.activeClass ?? "active";
        const want = b.isActiveFor(sm.activeMode);
        const has = b.panel.classList.contains(cls);
        if (want && !has) b.panel.classList.add(cls);
        else if (!want && has) b.panel.classList.remove(cls);
      }
    },
  };
}
