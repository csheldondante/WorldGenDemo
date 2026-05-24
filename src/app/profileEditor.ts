/**
 * ProfileEditor mode. Per user 2026-05-23 (DOD philosophy):
 *   "most editors for things like profiles should work by extracting
 *    constants we already use into buffers"
 *
 * The profile is ALREADY a buffer (CharacterControllerProfileBuffer).
 * The editor reads it directly + writes a form; user inputs mutate
 * the same buffer; live characters pick up the change next tick. No
 * intermediate "draft" or "snapshot" buffer — that'd be duplicated
 * state. The editor's only owned buffer is the tiny
 * `{ activeProfileId }` selector (= which profile the form is bound to).
 *
 * Per [[worldgen-demo-bindings-install-profiles-not-multipliers]]:
 * the profile IS the canonical data; editing it is the canonical
 * "change feel" operation. Bindings install profiles; the editor
 * mutates whichever profile is active.
 */

import { readBuffer, writeBuffer, type Buffer } from "../runtime/buffer";
import { createBuffer } from "../runtime/buffer";
import type { Registry } from "../runtime/registry";
import type { SystemDescriptor } from "../runtime/system";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
  type CharacterControllerProfile,
} from "../buffers/characterControllerProfile";

export const PROFILE_EDITOR_BUFFER_ID = "profileEditor";
export const PROFILE_EDITOR_RENDER_SYSTEM_ID = "profileEditorRenderSystem";
export const PROFILE_EDITOR_MODE_ID = "ProfileEditor";

export interface ProfileEditorBufferData {
  /** Profile id the editor is currently bound to. Defaults to "default"
   *  (= the player profile). Switching this rebinds the form. */
  activeProfileId: string;
}

export function createProfileEditorBuffer(): Buffer<ProfileEditorBufferData> {
  return createBuffer<ProfileEditorBufferData>({
    id: PROFILE_EDITOR_BUFFER_ID,
    description:
      "ProfileEditor mode buffer — tracks which profile id (CharacterControllerProfileBuffer.byId key) the editor's form is bound to. Editing the form mutates the profile buffer directly; no draft state.",
    initial: { activeProfileId: "default" },
  });
}

/** Render target shape — needs `innerHTML` write + `style.display`
 *  toggle (driven by OverlayVisibilitySystem). Production passes a
 *  real HTMLElement; tests can pass a stub. */
export interface ProfileEditorRenderTarget {
  innerHTML: string;
  style?: { display: string };
}

/**
 * Render system. Reads BOTH ProfileEditorBuffer (= activeProfileId)
 * AND CharacterControllerProfileBuffer (= the profile data). Writes
 * form HTML; the host attaches DOM listeners that call
 * `applyProfileEdit(reg, field, value)` to mutate the profile.
 *
 * Reading the profile buffer directly means no snapshot duplication
 * — the form always reflects the current profile state.
 */
export function createProfileEditorRenderSystem(
  target: ProfileEditorRenderTarget | null,
): SystemDescriptor {
  return {
    id: PROFILE_EDITOR_RENDER_SYSTEM_ID,
    description:
      "Renders the ProfileEditor form. Reads ProfileEditorBuffer for the active profile id + CharacterControllerProfileBuffer for the profile data. No-ops when target is null.",
    buffers: [
      { id: PROFILE_EDITOR_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
    ],
    execute: ({ buffer }) => {
      if (!target) return;
      const ed = readBuffer(buffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID));
      const profiles = readBuffer(buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
      const p = profiles.byId.get(ed.activeProfileId);
      target.innerHTML = renderEditor(ed.activeProfileId, p);
    },
  };
}

const EDITOR_CSS = `
<style>
.pe { font: 12px/1.5 ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; color: #d6d9df; }
.pe h2 { margin: 0 0 8px 0; font-size: 14px; color: #fff; border-bottom: 1px solid #444; padding-bottom: 4px; }
.pe h3 { margin: 14px 0 6px; font-size: 12px; color: #8ab; text-transform: uppercase; letter-spacing: 0.04em; }
.pe .row { display: grid; grid-template-columns: 180px 1fr 90px; gap: 8px; align-items: center; margin: 4px 0; }
.pe label { color: #9ab; }
.pe input[type="range"] { width: 100%; }
.pe input[type="number"] { background: #0b0e13; color: #ecaf3a; border: 1px solid #2a2e36; border-radius: 3px; padding: 2px 6px; font: inherit; width: 80px; text-align: right; }
.pe .pe-active { color: #9ec; }
.pe small { color: #7a8290; font-size: 11px; }
.pe .pe-section { background: #0b0e13; padding: 6px 10px; border: 1px solid #2a2e36; border-radius: 4px; margin-bottom: 8px; }
</style>
`;

function row(label: string, field: string, value: number, min: number, max: number, step: number, hint: string): string {
  return `<div class="row">
    <label>${label}</label>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-pe-field="${field}" />
    <input type="number" min="${min}" max="${max}" step="${step}" value="${value.toFixed(3)}" data-pe-field="${field}" />
  </div><small style="grid-column: 1 / -1; color:#666; margin-left:8px;">${hint}</small>`;
}

function renderEditor(activeId: string, p: CharacterControllerProfile | undefined): string {
  if (!p) {
    return `${EDITOR_CSS}<div class="pe"><h2>Profile Editor</h2><small>(no profile "${activeId}" loaded)</small></div>`;
  }
  return `${EDITOR_CSS}<div class="pe">
<h2>Profile Editor — <span class="pe-active">${activeId}</span></h2>
<small>Edits write back to CharacterControllerProfileBuffer.byId immediately. Live characters pick up changes next tick.</small>
<h3>Forward accel</h3>
<div class="pe-section">
  ${row("forward.vMax", "forwardVMax", p.forwardAccel.vMax, 0.5, 30, 0.1, "Sustainable forward speed (m/s)")}
  ${row("forward.accelAtZero", "forwardAccelAtZero", p.forwardAccel.accelAtZero, 1, 60, 0.5, "Max forward accel at v=0 (m/s²)")}
</div>
<h3>Backward accel</h3>
<div class="pe-section">
  ${row("backward.vMax", "backwardVMax", p.backwardAccel.vMax, 0.5, 30, 0.1, "Sustainable backward speed (m/s)")}
  ${row("backward.accelAtZero", "backwardAccelAtZero", p.backwardAccel.accelAtZero, 1, 60, 0.5, "Max backward accel at v=0 (m/s²)")}
</div>
<h3>Lateral accel</h3>
<div class="pe-section">
  ${row("lateral.vMax", "lateralVMax", p.lateralAccel.vMax, 0.5, 30, 0.1, "Sustainable lateral (strafe) speed (m/s)")}
  ${row("lateral.accelAtZero", "lateralAccelAtZero", p.lateralAccel.accelAtZero, 1, 60, 0.5, "Max lateral accel at v=0 (m/s²)")}
</div>
<h3>Grip + turn</h3>
<div class="pe-section">
  ${row("down.accelAtZero", "downAccelAtZero", p.downAccel.accelAtZero, 0, 30, 0.5, "Active press-into-surface force (m/s²). 0 for run, ~20 for climb.")}
  ${row("slideGripScale", "slideGripScale", p.slideGripScale, 0.1, 3, 0.05, "Grip-budget multiplier before slip → slide.")}
  ${row("desiredTurnRate", "desiredTurnRate", p.desiredTurnRate, 0.5, 15, 0.1, "How fast the character rotates toward the target heading (rad/s).")}
</div>
</div>`;
}

/** Editable field whitelist — used by applyProfileEdit and the
 *  render system's `data-pe-field` attributes. Keeping it in sync
 *  with the render markup is the test contract (see profileEditor.test.ts). */
export type EditableField =
  | "forwardVMax" | "forwardAccelAtZero"
  | "backwardVMax" | "backwardAccelAtZero"
  | "lateralVMax" | "lateralAccelAtZero"
  | "downAccelAtZero"
  | "slideGripScale"
  | "desiredTurnRate";

/**
 * Apply a single field edit to the active profile in the registry.
 * Called by the host's DOM event listener (= world.ts). The field
 * name comes from the input element's data-pe-field attribute.
 */
export function applyProfileEdit(
  reg: Registry,
  field: EditableField,
  value: number,
): void {
  const ed = reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID);
  const activeId = readBuffer(ed).activeProfileId;
  const profiles = reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID);
  writeBuffer(profiles, (d) => {
    const p = d.byId.get(activeId);
    if (!p) return;
    switch (field) {
      case "forwardVMax": p.forwardAccel = { ...p.forwardAccel, vMax: value }; break;
      case "forwardAccelAtZero": p.forwardAccel = { ...p.forwardAccel, accelAtZero: value }; break;
      case "backwardVMax": p.backwardAccel = { ...p.backwardAccel, vMax: value }; break;
      case "backwardAccelAtZero": p.backwardAccel = { ...p.backwardAccel, accelAtZero: value }; break;
      case "lateralVMax": p.lateralAccel = { ...p.lateralAccel, vMax: value }; break;
      case "lateralAccelAtZero": p.lateralAccel = { ...p.lateralAccel, accelAtZero: value }; break;
      case "downAccelAtZero": p.downAccel = { ...p.downAccel, accelAtZero: value }; break;
      case "slideGripScale": p.slideGripScale = value; break;
      case "desiredTurnRate": p.desiredTurnRate = value; break;
    }
    d.byId.set(activeId, p);
  });
}

/** Register the ProfileEditor mode. The systems list includes the SM
 *  + overlay visibility + the editor's render system. There is no
 *  separate "data" system — the render system reads from canonical
 *  buffers directly. */
export function registerProfileEditorMode(reg: Registry): void {
  reg.registerMode({
    id: PROFILE_EDITOR_MODE_ID,
    label: "Profile Editor",
    tags: ["debug"],
    systems: [
      "stateMachineSystem",
      "overlayVisibilitySystem",
      PROFILE_EDITOR_RENDER_SYSTEM_ID,
    ],
    ownedBuffers: [PROFILE_EDITOR_BUFFER_ID],
  });
}
