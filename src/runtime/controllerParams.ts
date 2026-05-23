/**
 * ControllerParams — the runtime buffer that carries the active
 * `ControllerBinding`'s `paramOverrides`. Modules read their slot's
 * params from this buffer at execute time; `applyControllerBinding`
 * writes new param values when the active binding changes.
 *
 * Per user 2026-05-23:
 *
 *   "bindings but also different parameter values for those bindings.
 *    some may be faster, accelerate more easily (more agile) or have
 *    different grip for example"
 *
 * This decouples MODULE CHOICE (= which system per slot) from MODULE
 * TUNING (= per-slot parameter values). Same modules + different
 * params produce "feel" variations between characters of the same
 * archetype (= standard vs. agile biped); different modules produce
 * different archetypes (= biped vs. vehicle).
 *
 * See `docs/modes-and-modules.md` and `src/runtime/moduleSlots.ts`.
 */

import { createBuffer, writeBuffer, type Buffer } from "./buffer";
import type { Registry } from "./registry";
import type { ControllerBinding, SlotId } from "./moduleSlots";

export const CONTROLLER_PARAMS_BUFFER_ID = "controllerParams";

export interface ControllerParamsBufferData {
  /** Id of the currently active binding. Empty string when no binding
   *  has been applied yet. */
  bindingId: string;
  /** Per-slot parameter overrides. Modules read their slot's entry. A
   *  missing slot key implies "no overrides, use module defaults". */
  bySlot: Record<SlotId, Record<string, unknown>>;
}

export function createControllerParamsBuffer(): Buffer<ControllerParamsBufferData> {
  return createBuffer<ControllerParamsBufferData>({
    id: CONTROLLER_PARAMS_BUFFER_ID,
    description:
      "Per-slot parameter overrides from the active ControllerBinding. Modules read their slot's overrides via readSlotParams() at execute time. Decouples per-character tuning (speed, grip, agility) from module identity.",
    initial: { bindingId: "", bySlot: {} },
  });
}

/**
 * Write a binding's `paramOverrides` into the runtime's
 * `ControllerParamsBuffer`. REPLACES the previous params (= the new
 * binding's values fully supersede; old params for absent slots are
 * NOT carried over). The buffer's `bindingId` field is updated to
 * `binding.id` so debug tooling can show the active binding.
 *
 * Idempotent — calling twice with the same binding is safe.
 */
export function applyControllerBinding(reg: Registry, binding: ControllerBinding): void {
  if (!reg.hasBuffer(CONTROLLER_PARAMS_BUFFER_ID)) {
    throw new Error(
      `applyControllerBinding: '${CONTROLLER_PARAMS_BUFFER_ID}' buffer is not registered. Call registerCoreBuffers (or createControllerParamsBuffer + registerBuffer) first.`,
    );
  }
  const buf = reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID);
  writeBuffer(buf, (d) => {
    d.bindingId = binding.id;
    d.bySlot = { ...(binding.paramOverrides ?? {}) };
  });
}

/**
 * Helper for module execute() functions. Returns the param object for
 * the given slot, or `{}` if no overrides are set for that slot.
 *
 * Usage pattern in a module's `execute`:
 *
 *   const paramsBuf = readBuffer(buffer<ControllerParamsBufferData>(
 *     CONTROLLER_PARAMS_BUFFER_ID));
 *   const params = readSlotParams(paramsBuf, SLOT_CHARACTER_INTENT);
 *   const speed = (params.speed as number) ?? DEFAULT_SPEED;
 */
export function readSlotParams(
  buf: ControllerParamsBufferData,
  slotId: SlotId,
): Record<string, unknown> {
  return buf.bySlot[slotId] ?? {};
}
