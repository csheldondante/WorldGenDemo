/**
 * Catalog of character bindings — Phase 5 of the modes-and-modules
 * refactor (see `docs/modes-and-modules.md`).
 *
 * Each binding shares the biped module set (= same systems in each
 * slot) but installs a distinct `CharacterControllerProfile` into the
 * characterIntent slot. Switching bindings writes the new profile
 * into `CharacterControllerProfileBuffer.byId`; existing systems
 * (TangentInputMapper, CharacterController, etc.) already read from
 * the profile buffer, so they pick up the change on the next tick.
 *
 * Per user 2026-05-23 (see
 * [[worldgen-demo-bindings-install-profiles-not-multipliers]]):
 * bindings install canonical profiles, they do NOT invent multiplier
 * knobs that duplicate the underlying 6DoF curves. The differences
 * between standard/agile/heavy are expressed as actual profile field
 * differences (forwardAccel.vMax, downAccel.accelAtZero, etc.).
 */

import type { ControllerBinding } from "../runtime/moduleSlots";
import { SLOT_CHARACTER_INTENT } from "../runtime/slotIds";
import {
  DEFAULT_PLAYER_PROFILE,
  type CharacterControllerProfile,
} from "../buffers/characterControllerProfile";

/** Canonical biped — uses the existing DEFAULT_PLAYER_PROFILE verbatim. */
export const BIPED_STANDARD_PROFILE: CharacterControllerProfile = DEFAULT_PLAYER_PROFILE;

/**
 * Agile biped — faster top speed + harder acceleration; less grip
 * (= lower downAccel.accelAtZero so friction-grip on slopes is
 * reduced; lower slideGripScale so the slip-to-slide trigger fires
 * earlier). Tighter turn rate too — the character is nimbler.
 */
export const BIPED_AGILE_PROFILE: CharacterControllerProfile = {
  ...DEFAULT_PLAYER_PROFILE,
  id: "biped:agile",
  desiredRunSpeed: DEFAULT_PLAYER_PROFILE.desiredRunSpeed * 1.6,
  forwardAccel: {
    ...DEFAULT_PLAYER_PROFILE.forwardAccel,
    vMax: DEFAULT_PLAYER_PROFILE.forwardAccel.vMax * 1.6,
    accelAtZero: DEFAULT_PLAYER_PROFILE.forwardAccel.accelAtZero * 1.4,
  },
  backwardAccel: {
    ...DEFAULT_PLAYER_PROFILE.backwardAccel,
    vMax: DEFAULT_PLAYER_PROFILE.backwardAccel.vMax * 1.6,
    accelAtZero: DEFAULT_PLAYER_PROFILE.backwardAccel.accelAtZero * 1.4,
  },
  lateralAccel: {
    ...DEFAULT_PLAYER_PROFILE.lateralAccel,
    vMax: DEFAULT_PLAYER_PROFILE.lateralAccel.vMax * 1.6,
    accelAtZero: DEFAULT_PLAYER_PROFILE.lateralAccel.accelAtZero * 1.4,
  },
  // Grip differentiation lives in slideGripScale (= the multiplier on
  // grip budget that triggers the slide transition). Lower = slips
  // sooner under lateral force. downAccel is 0 in the standard run
  // profile (= gravity does the pressing), so multiplying it has no
  // effect — see the buffer doc comment + wiki "6dof curves ARE the
  // grip mechanism".
  slideGripScale: DEFAULT_PLAYER_PROFILE.slideGripScale * 0.7,
  desiredTurnRate: DEFAULT_PLAYER_PROFILE.desiredTurnRate * 1.5,
  turnAccelMax: DEFAULT_PLAYER_PROFILE.turnAccelMax * 1.5,
};

/**
 * Heavy biped — slower top speed + softer acceleration; more grip
 * (= higher downAccel.accelAtZero so friction-grip is stronger;
 * higher slideGripScale so the character stays planted under harder
 * lateral force). Slower turn rate too.
 */
export const BIPED_HEAVY_PROFILE: CharacterControllerProfile = {
  ...DEFAULT_PLAYER_PROFILE,
  id: "biped:heavy",
  desiredRunSpeed: DEFAULT_PLAYER_PROFILE.desiredRunSpeed * 0.7,
  forwardAccel: {
    ...DEFAULT_PLAYER_PROFILE.forwardAccel,
    vMax: DEFAULT_PLAYER_PROFILE.forwardAccel.vMax * 0.7,
    accelAtZero: DEFAULT_PLAYER_PROFILE.forwardAccel.accelAtZero * 0.7,
  },
  backwardAccel: {
    ...DEFAULT_PLAYER_PROFILE.backwardAccel,
    vMax: DEFAULT_PLAYER_PROFILE.backwardAccel.vMax * 0.7,
    accelAtZero: DEFAULT_PLAYER_PROFILE.backwardAccel.accelAtZero * 0.7,
  },
  lateralAccel: {
    ...DEFAULT_PLAYER_PROFILE.lateralAccel,
    vMax: DEFAULT_PLAYER_PROFILE.lateralAccel.vMax * 0.7,
    accelAtZero: DEFAULT_PLAYER_PROFILE.lateralAccel.accelAtZero * 0.7,
  },
  // See agile note re: downAccel — slideGripScale is the run-mode
  // grip knob. Higher = stays planted longer under lateral force.
  slideGripScale: DEFAULT_PLAYER_PROFILE.slideGripScale * 1.4,
  desiredTurnRate: DEFAULT_PLAYER_PROFILE.desiredTurnRate * 0.6,
  turnAccelMax: DEFAULT_PLAYER_PROFILE.turnAccelMax * 0.6,
};

/** Standard biped binding — installs the default profile. */
export const BIPED_STANDARD: ControllerBinding = {
  id: "biped:standard",
  bindings: {}, // populated at runtime via materializeBindings()
  slotData: { [SLOT_CHARACTER_INTENT]: BIPED_STANDARD_PROFILE },
};

/** Agile biped binding — faster, snappier, less grip. */
export const BIPED_AGILE: ControllerBinding = {
  id: "biped:agile",
  bindings: {},
  slotData: { [SLOT_CHARACTER_INTENT]: BIPED_AGILE_PROFILE },
};

/** Heavy biped binding — slower, softer, more grip. */
export const BIPED_HEAVY: ControllerBinding = {
  id: "biped:heavy",
  bindings: {},
  slotData: { [SLOT_CHARACTER_INTENT]: BIPED_HEAVY_PROFILE },
};

/** All bindings in the catalog. The UI dropdown lists them in this order. */
export const CHARACTER_BINDINGS: readonly ControllerBinding[] = Object.freeze([
  BIPED_STANDARD,
  BIPED_AGILE,
  BIPED_HEAVY,
]);

/**
 * Merge the biped default binding's slot assignments into each
 * catalog binding (= they all share the same module set; only the
 * slotData differs). Returns a new array — originals are not mutated.
 *
 * After this transform, each binding is ready to be passed to
 * `applyControllerBinding(reg, binding)`: its `bindings` field has
 * the biped:default slot→module assignments, and its `slotData`
 * carries the binding-specific profile (and any future per-slot
 * canonical data).
 *
 * Note: all three bindings reuse the SAME profile id ("default") so
 * installing one REPLACES the other in CharacterControllerProfileBuffer.
 * Characters referencing profileId="default" pick up the swap on the
 * next tick.
 *
 * NB: agile/heavy profiles are stored under their own profile ids
 * (= "biped:agile", "biped:heavy") in the static catalog above. The
 * runtime profile-buffer entry written by applyControllerBinding
 * uses the profile's own `id` field, so existing character entities
 * referencing "default" need re-pointing if you want to swap them
 * to a different binding. We force the installed profile's id to
 * "default" here so live characters pick up the swap without
 * re-pointing — that matches the user-visible "binding swap = feel
 * change for the current character" semantic.
 */
export function materializeBindings(
  bipedDefault: ControllerBinding,
): ControllerBinding[] {
  return CHARACTER_BINDINGS.map((b) => {
    const profile = (b.slotData?.[SLOT_CHARACTER_INTENT] as CharacterControllerProfile | undefined);
    const reIdedProfile: CharacterControllerProfile | undefined = profile
      ? { ...profile, id: "default" }
      : undefined;
    return {
      ...b,
      bindings: bipedDefault.bindings,
      slotData: reIdedProfile ? { [SLOT_CHARACTER_INTENT]: reIdedProfile } : b.slotData,
    };
  });
}
