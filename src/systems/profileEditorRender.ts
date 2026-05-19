import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import {
  PROFILE_EDITOR_BUFFER_ID,
  type ProfileEditorBufferData,
} from "../buffers/profileEditor";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfile,
  type CharacterControllerProfileBufferData,
} from "../buffers/characterControllerProfile";
import { PROFILE_EDITOR_SYSTEM_ID } from "./profileEditor";

export const PROFILE_EDITOR_RENDER_SYSTEM_ID = "profileEditorRenderSystem";

/**
 * Renders the in-game profile editor panel inside the World tab. Reads
 * ProfileEditorBuffer (visible / which entity) + the character + profile
 * buffers and walks the active profile generically to produce a list of
 * editable inputs.
 *
 * Field-rendering rules:
 *
 * - `string` → `<input type="text">` (used for `name`; rest are read-only
 *   informational like `id`).
 * - `number` (finite) → `<input type="number">` with `step` chosen from the
 *   value's magnitude.
 * - `number` (`Infinity`) → text input showing `∞`; user can type any number
 *   or the literal `Infinity` to reset.
 * - Plain object → collapsible section, recursed.
 *
 * Onchange handlers writeBuffer the new value into the profile in place;
 * `version` bumps and downstream readers pick up the change immediately.
 *
 * DOM mutation uses an `id`-based render-once strategy: the panel skeleton is
 * built once per (entity, profile-id) pair, and only the live values + the
 * profile cycle indicator update on subsequent ticks. Prevents focus loss in
 * `<input>` elements while the user is typing.
 */
export function createProfileEditorRenderSystem(): SystemDescriptor {
  let lastBuiltKey: string | null = null;
  let rootDiv: HTMLDivElement | null = null;
  const inputs = new Map<string, HTMLInputElement>();
  return {
    id: PROFILE_EDITOR_RENDER_SYSTEM_ID,
    description:
      "Renders the in-game profile editor panel: shows active profile name, current state, cycle indicator, and a generic field list (numeric inputs for scalars, collapsible sections for nested objects). Writes back to CharacterControllerProfileBuffer on input changes.",
    buffers: [
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
      { id: PROFILE_EDITOR_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "readwrite" },
    ],
    // Runs after the compute editor + every profile-buffer writer so the
    // rendered values reflect the latest state for the tick.
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      PROFILE_EDITOR_SYSTEM_ID,
    ],
    execute: ({ buffer, now }) => {
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      const editor = readBuffer(buffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const profBuf = buffer<CharacterControllerProfileBufferData>(
        CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
      );
      const prof = readBuffer(profBuf);
      const host = refs.profileEditorEl;
      if (!host) return;

      if (!editor.visible) {
        if (host.style.display !== "none") host.style.display = "none";
        return;
      }
      host.style.display = "";

      const entity = editor.editingEntity;
      const ctrl = entity !== null ? cc.byEntity.get(entity) : null;
      const profile = ctrl ? prof.byId.get(ctrl.profileId) : null;

      // No character or profile to edit yet — show a placeholder.
      if (!ctrl || !profile) {
        const key = `__empty__`;
        if (lastBuiltKey !== key) {
          host.innerHTML = `<div class="pe-empty">No active character — open a scene with a player to edit profiles.</div>`;
          lastBuiltKey = key;
          rootDiv = null;
          inputs.clear();
        }
        return;
      }

      const buildKey = `${entity}::${profile.id}`;
      if (lastBuiltKey !== buildKey) {
        rebuildPanel(host, profile, ctrl.state, profBuf, prof.byId, inputs);
        lastBuiltKey = buildKey;
        rootDiv = host.querySelector("div.pe-root") as HTMLDivElement | null;
      }

      // Live updates that don't rebuild: state chip, cycle-flash, profile count,
      // and field values (in case something else wrote the profile).
      updateLiveValues(rootDiv, profile, ctrl.state, prof.byId.size, editor, now, inputs);
    },
  };
}

// ---------------------------------------------------------------------------
// Generic field-walk
// ---------------------------------------------------------------------------

interface FieldRow {
  path: string[];
  /** Type tag for the value at `path`. */
  kind: "string" | "number" | "infinity";
}

function walkFields(value: unknown, path: string[], out: FieldRow[]): void {
  if (typeof value === "string") {
    out.push({ path, kind: "string" });
    return;
  }
  if (typeof value === "number") {
    out.push({ path, kind: value === Infinity || value === -Infinity ? "infinity" : "number" });
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      walkFields(v, [...path, k], out);
    }
  }
  // Skip arrays / null / undefined / booleans for MVP — none of the current
  // profile fields use them at numeric-tunable positions.
}

function getAtPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur && typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

function setAtPath(obj: Record<string, unknown>, path: string[], v: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = cur[path[i]];
    if (next && typeof next === "object" && !Array.isArray(next)) {
      cur = next as Record<string, unknown>;
    } else {
      return;
    }
  }
  cur[path[path.length - 1]] = v;
}

/** Pick a sensible step for a number input based on the value's magnitude. */
function stepFor(v: number): number {
  const a = Math.abs(v);
  if (a >= 100) return 1;
  if (a >= 10) return 0.1;
  if (a >= 1) return 0.01;
  if (a >= 0.1) return 0.001;
  return 0.0001;
}

// ---------------------------------------------------------------------------
// DOM construction
// ---------------------------------------------------------------------------

function rebuildPanel(
  host: HTMLElement,
  profile: CharacterControllerProfile,
  state: string,
  profBuf: import("../runtime/buffer").Buffer<CharacterControllerProfileBufferData>,
  byId: ReadonlyMap<string, CharacterControllerProfile>,
  inputs: Map<string, HTMLInputElement>,
): void {
  inputs.clear();
  host.innerHTML = "";
  const root = document.createElement("div");
  root.className = "pe-root";

  // Header: name + state + profile count
  const header = document.createElement("div");
  header.className = "pe-header";
  const nameRow = document.createElement("div");
  nameRow.className = "pe-name-row";
  const nameLabel = document.createElement("label");
  nameLabel.textContent = "name";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = profile.name;
  nameInput.className = "pe-name-input";
  nameInput.addEventListener("input", () => {
    writeBuffer(profBuf, (d) => {
      const p = d.byId.get(profile.id);
      if (p) p.name = nameInput.value;
    });
  });
  nameRow.appendChild(nameLabel);
  nameRow.appendChild(nameInput);
  inputs.set("__name__", nameInput);

  const meta = document.createElement("div");
  meta.className = "pe-meta";
  const stateChip = document.createElement("span");
  stateChip.className = "pe-state";
  stateChip.dataset.role = "state";
  stateChip.textContent = state;
  const idChip = document.createElement("span");
  idChip.className = "pe-id";
  idChip.textContent = `id: ${profile.id}`;
  const countChip = document.createElement("span");
  countChip.className = "pe-count";
  countChip.dataset.role = "count";
  countChip.textContent = `${byId.size} profile${byId.size === 1 ? "" : "s"}`;
  meta.appendChild(stateChip);
  meta.appendChild(idChip);
  meta.appendChild(countChip);

  const hint = document.createElement("div");
  hint.className = "pe-hint";
  hint.textContent = "[ / ] cycle · N clone · ` close";

  header.appendChild(nameRow);
  header.appendChild(meta);
  header.appendChild(hint);
  root.appendChild(header);

  // Field list — walk every non-name string + every number.
  const rows: FieldRow[] = [];
  walkFields(profile, [], rows);
  const filtered = rows.filter((r) => {
    // Hide `id` and `name` — they're handled separately above.
    if (r.path.length === 1 && (r.path[0] === "id" || r.path[0] === "name")) return false;
    return true;
  });

  const fieldList = document.createElement("div");
  fieldList.className = "pe-fields";

  // Group rows by their top-level group key (top-level scalars under "general").
  const groups = new Map<string, FieldRow[]>();
  for (const r of filtered) {
    const groupKey = r.path.length === 1 ? "general" : r.path[0];
    let arr = groups.get(groupKey);
    if (!arr) {
      arr = [];
      groups.set(groupKey, arr);
    }
    arr.push(r);
  }

  for (const [groupKey, groupRows] of groups) {
    const section = document.createElement("details");
    section.className = "pe-section";
    section.open = groupKey === "general";
    const summary = document.createElement("summary");
    summary.textContent = groupKey;
    section.appendChild(summary);
    for (const row of groupRows) {
      const value = getAtPath(profile, row.path);
      if (typeof value !== "number") continue;
      const fieldRow = document.createElement("div");
      fieldRow.className = "pe-field";
      const label = document.createElement("label");
      label.textContent = row.path.join(".");
      const input = document.createElement("input");
      const key = row.path.join(".");
      if (row.kind === "infinity") {
        input.type = "text";
        input.value = value > 0 ? "∞" : "-∞";
      } else {
        input.type = "number";
        input.step = String(stepFor(value));
        input.value = String(value);
      }
      input.dataset.kind = row.kind;
      input.addEventListener("change", () => onFieldChange(profBuf, profile.id, row.path, input));
      fieldRow.appendChild(label);
      fieldRow.appendChild(input);
      section.appendChild(fieldRow);
      inputs.set(key, input);
    }
    fieldList.appendChild(section);
  }
  root.appendChild(fieldList);
  host.appendChild(root);
}

function onFieldChange(
  profBuf: import("../runtime/buffer").Buffer<CharacterControllerProfileBufferData>,
  profileId: string,
  path: string[],
  input: HTMLInputElement,
): void {
  const raw = input.value.trim();
  let parsed: number;
  if (raw === "∞" || raw === "Infinity" || raw === "inf") {
    parsed = Infinity;
  } else if (raw === "-∞" || raw === "-Infinity" || raw === "-inf") {
    parsed = -Infinity;
  } else {
    parsed = Number(raw);
  }
  if (Number.isNaN(parsed)) {
    input.classList.add("pe-invalid");
    return;
  }
  input.classList.remove("pe-invalid");
  writeBuffer(profBuf, (d) => {
    const p = d.byId.get(profileId);
    if (p) setAtPath(p as unknown as Record<string, unknown>, path, parsed);
  });
}

function updateLiveValues(
  root: HTMLDivElement | null,
  profile: CharacterControllerProfile,
  state: string,
  count: number,
  editor: ProfileEditorBufferData,
  now: number,
  inputs: Map<string, HTMLInputElement>,
): void {
  if (!root) return;
  const stateChip = root.querySelector('[data-role="state"]') as HTMLElement | null;
  if (stateChip && stateChip.textContent !== state) stateChip.textContent = state;
  const countChip = root.querySelector('[data-role="count"]') as HTMLElement | null;
  const countText = `${count} profile${count === 1 ? "" : "s"}`;
  if (countChip && countChip.textContent !== countText) countChip.textContent = countText;

  // Flash the panel border for ~400ms after a cycle/clone so the user can tell
  // their key registered.
  const FLASH_MS = 400;
  const elapsed = now - editor.lastSwitchedAtMs;
  if (editor.lastSwitchedProfileId !== null && elapsed >= 0 && elapsed < FLASH_MS) {
    root.classList.add("pe-flash");
  } else {
    root.classList.remove("pe-flash");
  }

  // Refresh field values from the profile (only when the input is not focused,
  // so the user's in-flight edits aren't clobbered).
  for (const [key, input] of inputs) {
    if (key === "__name__") {
      if (document.activeElement !== input && input.value !== profile.name) {
        input.value = profile.name;
      }
      continue;
    }
    if (document.activeElement === input) continue;
    const path = key.split(".");
    const v = getAtPath(profile, path);
    if (typeof v !== "number") continue;
    const kind = input.dataset.kind;
    const display =
      kind === "infinity"
        ? v > 0
          ? "∞"
          : v < 0
            ? "-∞"
            : "0"
        : String(v);
    if (input.value !== display) input.value = display;
  }
}
