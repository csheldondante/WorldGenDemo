/**
 * Catalog of character bindings — Phase 5 of the modes-and-modules
 * refactor (see `docs/modes-and-modules.md`).
 *
 * Each binding shares the biped module set (same systems in each
 * slot) but carries distinct `paramOverrides`. Switching bindings at
 * runtime writes the new params into `ControllerParamsBuffer`; module
 * systems that read from that buffer pick up the values on the next
 * tick.
 *
 * Per user 2026-05-23: "some may be faster, accelerate more easily
 * (more agile) or have different grip for example".
 *
 * Today the existing biped systems don't yet consume params from
 * ControllerParamsBuffer (= they read from CharacterControllerProfile
 * directly), so switching bindings is a no-op visibly. Phase 5b will
 * refactor one or more systems (= TangentInputMapper, surface
 * constraint) to consult ControllerParamsBuffer first and fall back
 * to the profile buffer, producing live behavior change on bind swap.
 *
 * For now this catalog demonstrates the SHAPE of multi-binding
 * configuration so the UI + serialization paths land + the tests
 * verify swap semantics end-to-end.
 */

import type { ControllerBinding } from "../runtime/moduleSlots";
import {
  SLOT_CHARACTER_INTENT,
  SLOT_PHYSICS,
} from "../runtime/slotIds";

/** Canonical biped — moderate speed, neutral grip. The default. */
export const BIPED_STANDARD: ControllerBinding = {
  id: "biped:standard",
  bindings: {},  // populated at runtime via mergeBindingSlots() with biped:default's slots
  paramOverrides: {
    [SLOT_CHARACTER_INTENT]: { speedMultiplier: 1.0, gripMultiplier: 1.0 },
    [SLOT_PHYSICS]: { dragMultiplier: 1.0 },
  },
};

/** Agile biped — faster, lower grip → slidier on corners. */
export const BIPED_AGILE: ControllerBinding = {
  id: "biped:agile",
  bindings: {},
  paramOverrides: {
    [SLOT_CHARACTER_INTENT]: { speedMultiplier: 1.6, gripMultiplier: 0.7 },
    [SLOT_PHYSICS]: { dragMultiplier: 0.8 },
  },
};

/** Heavy biped — slower, higher grip → planted on corners. */
export const BIPED_HEAVY: ControllerBinding = {
  id: "biped:heavy",
  bindings: {},
  paramOverrides: {
    [SLOT_CHARACTER_INTENT]: { speedMultiplier: 0.7, gripMultiplier: 1.4 },
    [SLOT_PHYSICS]: { dragMultiplier: 1.3 },
  },
};

/** All bindings in the catalog. The UI dropdown lists them in this order. */
export const CHARACTER_BINDINGS: readonly ControllerBinding[] = Object.freeze([
  BIPED_STANDARD,
  BIPED_AGILE,
  BIPED_HEAVY,
]);

/**
 * Merge the biped default binding's slot assignments into each
 * catalog binding (= they all use the same module set; only the
 * paramOverrides differ). Returns a new array of bindings — original
 * catalog entries are not mutated.
 *
 * After this transform, each binding is ready to be passed to
 * `applyControllerBinding(reg, binding)`: its `bindings` field has the
 * biped:default slot→module assignments, and its paramOverrides are
 * the catalog's per-binding tuning values.
 */
export function materializeBindings(
  bipedDefault: ControllerBinding,
): ControllerBinding[] {
  return CHARACTER_BINDINGS.map((b) => ({
    ...b,
    bindings: bipedDefault.bindings,
  }));
}
