import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../buffers/inputMap";
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
import { INPUT_MAPPER_SYSTEM_ID } from "./inputMapper";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { CHARACTER_ORIENTATION_SYSTEM_ID } from "./characterOrientation";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { BODY_LEAN_SYSTEM_ID } from "./bodyLean";
import { CHARACTER_RENDER_SYNC_SYSTEM_ID } from "./characterRenderSync";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "./chainDynamics";
import { FOOT_PLANNER_SYSTEM_ID } from "./footPlanner";
import { FOOT_IK_SYSTEM_ID } from "./footIk";
import { SKELETON_WORLD_SYSTEM_ID } from "./skeletonWorld";
import { SKELETON_DEBUG_RENDER_SYSTEM_ID } from "./skeletonDebugRender";
import { HUD_SYSTEM_ID } from "./hud";
import { MINIMAP_SYSTEM_ID } from "./minimap";

export const PROFILE_EDITOR_SYSTEM_ID = "profileEditorSystem";

/**
 * Drives the in-game profile editor's state from semantic actions:
 *
 * - `toggleProfileEditor` (Backquote): flips `ProfileEditorBuffer.visible`. On
 *   first open, latches `editingEntity` to the first surface-attached entity.
 * - `cycleProfilePrev` / `cycleProfileNext` ([ / ]): rotates the edited
 *   entity's `profileId` through `CharacterControllerProfileBuffer.byId`
 *   entries in insertion order. Records the new id in
 *   `lastSwitchedProfileId` for the renderer's UI flash.
 * - `cloneProfile` (KeyN): deep-clones the edited entity's current profile to
 *   a new id like `<old>-clone-N`, registers it, and switches the entity to
 *   it. Useful for "diverge then edit" without losing the source profile.
 *
 * Rendering of the panel is handled separately by `ProfileEditorRenderSystem`
 * — this system only owns the state transitions, so it stays headless and
 * testable.
 */
export function createProfileEditorSystem(): SystemDescriptor {
  return {
    id: PROFILE_EDITOR_SYSTEM_ID,
    description:
      "Owns ProfileEditorBuffer state transitions in response to InputMap semantic actions. Toggles visibility, cycles the edited entity's profileId, clones the current profile to a new id. Does not touch the DOM — ProfileEditorRenderSystem handles rendering.",
    buffers: [
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
      { id: PROFILE_EDITOR_BUFFER_ID, access: "readwrite" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "readwrite" },
    ],
    // Runs at the very end of the per-tick character pipeline so it sees the
    // freshest CharacterControllerBuffer state when deciding what to display
    // and so its profileId writes only take effect on the next tick. List
    // every reader + writer of ctrl explicitly; out-of-graph ids are silently
    // dropped, so this works across Running et al.
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      INPUT_MAPPER_SYSTEM_ID,
      CHARACTER_CONTROLLER_SYSTEM_ID,
      CHARACTER_ORIENTATION_SYSTEM_ID,
      SURFACE_CONSTRAINT_SYSTEM_ID,
      BODY_LEAN_SYSTEM_ID,
      CHARACTER_RENDER_SYNC_SYSTEM_ID,
      CHAIN_DYNAMICS_SYSTEM_ID,
      FOOT_PLANNER_SYSTEM_ID,
      FOOT_IK_SYSTEM_ID,
      SKELETON_WORLD_SYSTEM_ID,
      SKELETON_DEBUG_RENDER_SYSTEM_ID,
      HUD_SYSTEM_ID,
      MINIMAP_SYSTEM_ID,
    ],
    execute: ({ buffer, now }) => {
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const editorBuf = buffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID);
      const ccBuf = buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
      const profBuf = buffer<CharacterControllerProfileBufferData>(
        CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
      );
      const editor = readBuffer(editorBuf);
      const cc = readBuffer(ccBuf);
      const prof = readBuffer(profBuf);

      const toggle = im.actions.toggleProfileEditor.pressed;
      const cyclePrev = im.actions.cycleProfilePrev.pressed;
      const cycleNext = im.actions.cycleProfileNext.pressed;
      const clone = im.actions.cloneProfile.pressed;

      if (!toggle && !cyclePrev && !cycleNext && !clone) return;

      // Resolve which entity to edit. Latch on first open / first action; keep
      // sticky until a future action explicitly changes it (none today).
      let entity = editor.editingEntity;
      if (entity === null || !cc.byEntity.has(entity)) {
        const firstId = cc.byEntity.keys().next().value;
        entity = firstId ?? null;
      }

      let visible = editor.visible;
      let lastSwitchedProfileId = editor.lastSwitchedProfileId;
      let lastSwitchedAtMs = editor.lastSwitchedAtMs;

      if (toggle) visible = !visible;

      // Profile cycle + clone need an entity to act on.
      if (entity !== null && (cyclePrev || cycleNext || clone)) {
        const ctrl = cc.byEntity.get(entity);
        if (ctrl) {
          const ids = Array.from(prof.byId.keys());
          const currentIdx = ids.indexOf(ctrl.profileId);
          let nextProfileId: string | null = null;

          if (cyclePrev && ids.length > 0) {
            const i = currentIdx < 0 ? 0 : (currentIdx - 1 + ids.length) % ids.length;
            nextProfileId = ids[i];
          } else if (cycleNext && ids.length > 0) {
            const i = currentIdx < 0 ? 0 : (currentIdx + 1) % ids.length;
            nextProfileId = ids[i];
          } else if (clone) {
            const source = prof.byId.get(ctrl.profileId);
            if (source) {
              const newId = uniqueCloneId(source.id, prof.byId);
              const cloned = cloneProfile(source, newId);
              writeBuffer(profBuf, (d) => {
                d.byId.set(newId, cloned);
              });
              nextProfileId = newId;
            }
          }

          if (nextProfileId !== null) {
            const targetEntity = entity;
            writeBuffer(ccBuf, (d) => {
              const c = d.byEntity.get(targetEntity);
              if (c) c.profileId = nextProfileId!;
            });
            lastSwitchedProfileId = nextProfileId;
            lastSwitchedAtMs = now;
          }
        }
      }

      writeBuffer(editorBuf, (d) => {
        d.visible = visible;
        d.editingEntity = entity;
        d.lastSwitchedProfileId = lastSwitchedProfileId;
        d.lastSwitchedAtMs = lastSwitchedAtMs;
      });
    },
  };
}

function uniqueCloneId(baseId: string, byId: Map<string, CharacterControllerProfile>): string {
  // `<baseId>-clone`, `<baseId>-clone-2`, `<baseId>-clone-3`, ...
  // Strip any existing `-clone(-N)?` suffix from base so chained clones don't
  // produce `player-clone-clone-clone`.
  const stripped = baseId.replace(/-clone(-\d+)?$/, "");
  let candidate = `${stripped}-clone`;
  if (!byId.has(candidate)) return candidate;
  let n = 2;
  while (byId.has(`${stripped}-clone-${n}`)) n++;
  return `${stripped}-clone-${n}`;
}

function cloneProfile(
  source: CharacterControllerProfile,
  newId: string,
): CharacterControllerProfile {
  // Deep clone via structured clone — handles nested objects (jump, climb)
  // and primitive fields without needing to enumerate each one. Falls back
  // to JSON for environments without structuredClone (older test runners).
  const clone: CharacterControllerProfile =
    typeof structuredClone === "function"
      ? (structuredClone(source) as CharacterControllerProfile)
      : (JSON.parse(JSON.stringify(source, infinityReplacer), infinityReviver) as CharacterControllerProfile);
  clone.id = newId;
  clone.name = newId;
  return clone;
}

// Infinity round-trip helpers for the JSON fallback path. Curves use Infinity
// for `vMax` to mean "no velocity cap"; plain JSON drops it to null.
function infinityReplacer(_key: string, value: unknown): unknown {
  if (value === Infinity) return "__inf__";
  if (value === -Infinity) return "__neginf__";
  return value;
}
function infinityReviver(_key: string, value: unknown): unknown {
  if (value === "__inf__") return Infinity;
  if (value === "__neginf__") return -Infinity;
  return value;
}
