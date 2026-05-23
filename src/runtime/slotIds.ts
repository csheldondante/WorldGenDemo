/**
 * Canonical module slot ids — Phase 4b of the modes-and-modules
 * refactor (see `docs/modes-and-modules.md`).
 *
 * These string constants are the stable interface contract that
 * character-archetype Modules (`createModuleRegistry`) bind against. A
 * Module is registered with `slotId: SLOT_CHARACTER_INTENT` (etc.), and
 * a ControllerBinding maps each slot id to a chosen module's id.
 *
 * The slot order (`CANONICAL_SLOT_ORDER`) reflects the tick-flow
 * dependency: input is normalized first, then mapped to semantic
 * actions, then resolved into camera + character intent, then the
 * camera updates, collision is resolved, controller FSM updates,
 * physics integrates, and animation produces visual output.
 *
 * Phase 4b only declares the taxonomy — existing character systems are
 * NOT yet wrapped as modules for each slot. Phase 4c wraps the systems
 * we already have (= an existing `tangentInputMapper` becomes a
 * "biped:characterIntent" module, etc.). Phase 4d refactors the
 * gameplay graph to consume a ControllerBinding rather than a
 * hand-curated system list.
 *
 * The strings are deliberately camelCase + descriptive so they read
 * well in debug UI ("Slot: characterIntent") and JSON snapshots.
 */

import type { SlotId } from "./moduleSlots";

export const SLOT_INPUT_NORMALIZATION: SlotId = "inputNormalization";
export const SLOT_INPUT_SEMANTIC_MAPPING: SlotId = "inputSemanticMapping";
export const SLOT_CAMERA_INTENT: SlotId = "cameraIntent";
export const SLOT_CHARACTER_INTENT: SlotId = "characterIntent";
export const SLOT_CAMERA_UPDATE: SlotId = "cameraUpdate";
export const SLOT_COLLISION: SlotId = "collision";
export const SLOT_CHARACTER_UPDATE: SlotId = "characterUpdate";
export const SLOT_PHYSICS: SlotId = "physics";
export const SLOT_ANIMATION: SlotId = "animation";

/**
 * Canonical tick-flow ordering of slots. A character-controller graph
 * built from a ControllerBinding orders modules by their slot's
 * position in this array — guaranteeing input → intent → camera →
 * collision → character → physics → animation each tick. Within a
 * slot, multiple modules (rare) are inserted in registration order.
 */
export const CANONICAL_SLOT_ORDER: readonly SlotId[] = Object.freeze([
  SLOT_INPUT_NORMALIZATION,
  SLOT_INPUT_SEMANTIC_MAPPING,
  SLOT_CAMERA_INTENT,
  SLOT_CHARACTER_INTENT,
  SLOT_CAMERA_UPDATE,
  SLOT_COLLISION,
  SLOT_CHARACTER_UPDATE,
  SLOT_PHYSICS,
  SLOT_ANIMATION,
]);

const VALID_SLOTS: ReadonlySet<string> = new Set<string>(CANONICAL_SLOT_ORDER);

/** True iff `s` is one of the canonical slot ids. Case-sensitive. */
export function isValidSlotId(s: string): boolean {
  return VALID_SLOTS.has(s);
}
