/**
 * Apply a ControllerBinding's slot data to the runtime's domain
 * buffers. Per [[worldgen-demo-bindings-install-profiles-not-multipliers]]:
 * each slot's data is the canonical shape that slot's modules already
 * read. characterIntent → CharacterControllerProfile, installed into
 * CharacterControllerProfileBuffer.byId. Other slots get added as
 * their domain data shapes are defined.
 *
 * Lives in src/app/ because it needs to import buffer types (= not
 * permitted from src/runtime/ per layer rules). The runtime side
 * (`src/runtime/moduleSlots.ts`) owns the ControllerBinding TYPE
 * with opaque slotData; this file owns its INTERPRETATION.
 */

import type { Registry } from "../runtime/registry";
import { writeBuffer } from "../runtime/buffer";
import type { ControllerBinding, SlotId } from "../runtime/moduleSlots";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
  type CharacterControllerProfile,
} from "../buffers/characterControllerProfile";
import { SLOT_CHARACTER_INTENT } from "../runtime/slotIds";

/**
 * Apply the binding by routing each slot's data to its destination
 * buffer. Idempotent — re-applying the same binding writes the same
 * values.
 *
 * Throws if a slot's data fails its destination's shape contract (=
 * dev-loud signal rather than silent partial application).
 */
export function applyControllerBinding(reg: Registry, binding: ControllerBinding): void {
  const slotData = binding.slotData ?? {};
  for (const [slotId, data] of Object.entries(slotData) as [SlotId, unknown][]) {
    installSlot(reg, binding.id, slotId, data);
  }
}

function installSlot(reg: Registry, bindingId: string, slotId: SlotId, data: unknown): void {
  switch (slotId) {
    case SLOT_CHARACTER_INTENT:
      installCharacterProfile(reg, bindingId, data);
      return;
    default:
      // Unknown slots are no-ops for now — future slot domains
      // (cameraIntent, physics, animation) plug their installer
      // here as their canonical buffer/shape is defined.
      return;
  }
}

function installCharacterProfile(reg: Registry, bindingId: string, data: unknown): void {
  if (!isCharacterControllerProfile(data)) {
    throw new Error(
      `applyControllerBinding('${bindingId}'): characterIntent slot data does not match CharacterControllerProfile shape. ` +
        `Bindings install full profiles into CharacterControllerProfileBuffer.byId — see ` +
        `wiki/worldgen-demo-bindings-install-profiles-not-multipliers.`,
    );
  }
  const buf = reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID);
  writeBuffer(buf, (d) => {
    d.byId.set(data.id, data);
  });
}

function isCharacterControllerProfile(x: unknown): x is CharacterControllerProfile {
  if (!x || typeof x !== "object") return false;
  const p = x as Partial<CharacterControllerProfile>;
  return (
    typeof p.id === "string" &&
    typeof p.desiredRunSpeed === "number" &&
    typeof p.forwardAccel === "object" &&
    typeof p.lateralAccel === "object" &&
    typeof p.downAccel === "object" &&
    typeof p.bodyRadius === "number"
  );
}
