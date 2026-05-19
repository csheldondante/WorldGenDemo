import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";
import type { ProfileId } from "./characterControllerProfile";

/**
 * In-game profile-editor UI state. Owned by data so the editor's open/closed
 * state, currently-edited entity, and last-action timestamps are visible to
 * tests, debug overlays, and smoke captures — not stuck in a closure.
 *
 * Wire-up:
 * - `ProfileEditorSystem` writes `visible`, `editingEntity`, and the
 *   `lastClonedProfileId` / `lastCycledAtMs` fields in response to semantic
 *   actions on `InputMapBuffer` (toggle, cycle, clone). It also mutates
 *   `CharacterControllerProfileBuffer.byId` (rename, clone) and
 *   `CharacterControllerBuffer.byEntity[id].profileId` (switch active).
 * - `ProfileEditorRenderSystem` reads this buffer + the profile + controller
 *   buffers and renders an HTML panel inside the World tab. When `visible`
 *   is false it hides the DOM and does no further work.
 */
export interface ProfileEditorBufferData {
  /** Whether the editor panel is shown. Toggled by the toggleProfileEditor action. */
  visible: boolean;
  /** Entity whose profile is currently being edited. Null means "the first
   *  surface-attached character we find" (set on first open). Stays sticky
   *  across cycles so the same entity remains under edit. */
  editingEntity: EntityId | null;
  /** Profile id last switched into via cycle or clone. Drives a brief UI flash
   *  in the renderer so the user can tell their key press registered. */
  lastSwitchedProfileId: ProfileId | null;
  /** Scheduler `now` (ms) when the last cycle/clone happened. Renderer uses
   *  this to time the flash. */
  lastSwitchedAtMs: number;
}

export const PROFILE_EDITOR_BUFFER_ID = "profileEditor";

export function createProfileEditorBuffer(): Buffer<ProfileEditorBufferData> {
  return createBuffer<ProfileEditorBufferData>({
    id: PROFILE_EDITOR_BUFFER_ID,
    description:
      "Profile-editor UI state: visible flag, entity under edit, last-switched profile id + timestamp for the UI flash. Owned by data so tests/smoke captures can drive it without DOM. ProfileEditorSystem reads InputMapBuffer actions (toggleProfileEditor, cycleProfile{Prev,Next}, cloneProfile) and mutates this buffer + the profile/controller buffers. ProfileEditorRenderSystem reads this buffer and the profile to render the panel.",
    initial: {
      visible: false,
      editingEntity: null,
      lastSwitchedProfileId: null,
      lastSwitchedAtMs: 0,
    },
  });
}
