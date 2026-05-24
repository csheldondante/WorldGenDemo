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
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";

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
<h2>Profile Editor — <span class="pe-active">${activeId}</span>
  <button data-pe-action="save" style="float:right;background:#2a4;color:#fff;border:1px solid #444;padding:2px 10px;font:inherit;border-radius:3px;cursor:pointer;margin-left:6px">⬇ save</button>
  <button data-pe-action="clone" style="float:right;background:#2c4a78;color:#fff;border:1px solid #444;padding:2px 10px;font:inherit;border-radius:3px;cursor:pointer">＋ clone</button>
</h2>
<small>Edits write back to CharacterControllerProfileBuffer.byId immediately. Live characters pick up changes next tick. "Clone" duplicates the active profile under a new id and switches the editor + live character to the new id (= safe to experiment without overwriting the original).</small>
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

/**
 * Clone the active profile under a new id. Per user 2026-05-23:
 * "adding a new profile (cloning one) would just copy a new entry
 * into the data buffer which editors would then directly edit".
 *
 * Steps:
 *   1. Read the active profile from CharacterControllerProfileBuffer.
 *   2. Write a copy with a new id (= base id + "-clone-N" suffix,
 *      where N is the next free integer).
 *   3. Point ProfileEditorBuffer.activeProfileId at the new id.
 *   4. Repoint every CharacterController entity that referenced the
 *      old id to the new id (= live characters feel subsequent edits).
 *
 * The original profile remains in the buffer — you can re-select it
 * from the editor's profile-id picker (future) or by writing the id
 * back into activeProfileId.
 *
 * Returns the new profile id (= for UI feedback / further automation).
 */
export function cloneActiveProfile(reg: Registry): string | null {
  const ed = reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID);
  const sourceId = readBuffer(ed).activeProfileId;
  const profiles = reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID);
  const source = readBuffer(profiles).byId.get(sourceId);
  if (!source) return null;
  // Find the next free clone id: sourceId-clone-1, -2, ...
  const baseId = sourceId.replace(/-clone-\d+$/, "");
  let n = 1;
  let newId = `${baseId}-clone-${n}`;
  while (readBuffer(profiles).byId.has(newId)) {
    n += 1;
    newId = `${baseId}-clone-${n}`;
  }
  // Deep enough copy: the curve sub-objects are mutated independently
  // by applyProfileEdit, so they need their own references.
  const cloneProfile: CharacterControllerProfile = {
    ...source,
    id: newId,
    forwardAccel: { ...source.forwardAccel },
    backwardAccel: { ...source.backwardAccel },
    lateralAccel: { ...source.lateralAccel },
    upAccel: { ...source.upAccel },
    downAccel: { ...source.downAccel },
    jump: { ...source.jump },
    climb: { ...source.climb },
  };
  writeBuffer(profiles, (d) => { d.byId.set(newId, cloneProfile); });
  writeBuffer(ed, (d) => { d.activeProfileId = newId; });
  // Repoint live characters from sourceId → newId so they feel
  // subsequent edits. Characters that used a different profile id
  // are untouched.
  if (reg.hasBuffer(CHARACTER_CONTROLLER_BUFFER_ID)) {
    const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
    writeBuffer(cc, (d) => {
      for (const [id, ctrl] of d.byEntity) {
        if (ctrl.profileId === sourceId) {
          d.byEntity.set(id, { ...ctrl, profileId: newId });
        }
      }
    });
  }
  return newId;
}

/**
 * Serialize the active profile to a JSON-friendly object. Suitable
 * for `JSON.stringify` + clientside download or filesystem write.
 * Returns null if the active profile id has no profile.
 */
export function serializeActiveProfile(reg: Registry): { profileId: string; profile: CharacterControllerProfile } | null {
  const ed = reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID);
  const activeId = readBuffer(ed).activeProfileId;
  const profiles = reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID);
  const p = readBuffer(profiles).byId.get(activeId);
  if (!p) return null;
  return { profileId: activeId, profile: p };
}

/** Register the ProfileEditor mode as an OVERLAY on top of Running.
 *  Gameplay continues (= character keeps simulating) while the editor
 *  is open; edits to the profile buffer take effect on the live
 *  character next tick. Per user 2026-05-23: "I want to be able to
 *  tweak and play in the gym scene so that I can swap out profiles
 *  on the controller or tweak specific values and test out".
 *
 *  Caller supplies the Running mode's systems list — this avoids a
 *  src/app/ → src/runtime/ circular reference for the mode lookup,
 *  and ensures the editor's systems list grows automatically when
 *  Running's does.
 */
export function registerProfileEditorMode(reg: Registry, runningSystems: string[]): void {
  const editorOnly = [PROFILE_EDITOR_RENDER_SYSTEM_ID];
  // Dedupe — Running already includes panelVisibilitySystem +
  // overlayVisibilitySystem + stateMachineSystem.
  const systems = [...runningSystems, ...editorOnly.filter((id) => !runningSystems.includes(id))];
  reg.registerMode({
    id: PROFILE_EDITOR_MODE_ID,
    label: "Profile Editor",
    tags: ["debug"],
    systems,
    ownedBuffers: [PROFILE_EDITOR_BUFFER_ID],
  });
}
