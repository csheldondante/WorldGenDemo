/**
 * BindingSwapSystem — handles `BindingRequested` events from the
 * event buffer by calling `applyControllerBinding` on the matching
 * binding from a runtime-provided catalog.
 *
 * Replaces the prior direct imperative call from the binding-picker
 * UI (= DOM event handler called `applyControllerBinding` synchronously
 * with no event flow). Tech-debt payoff 2026-05-23.
 *
 * Per the data-oriented-design rule: UI inputs become EVENTS in the
 * event buffer; systems drain the events and update buffers. The
 * binding swap is now scenario-driveable, replayable, undoable, and
 * visible to debug tooling.
 */

import { readBuffer, writeBuffer } from "./buffer";
import type { SystemDescriptor } from "./system";
import type { Registry } from "./registry";
import type { ControllerBinding } from "./moduleSlots";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "./stateMachine";
import { applyControllerBinding, CONTROLLER_PARAMS_BUFFER_ID } from "./controllerParams";

export const BINDING_SWAP_SYSTEM_ID = "bindingSwapSystem";

/**
 * Factory for the BindingSwapSystem. Closes over the registry +
 * binding catalog. Each tick drains `BindingRequested` events from
 * the event buffer; if the payload matches a catalog binding, applies
 * it via `applyControllerBinding`. Unknown ids are silently ignored.
 *
 * If multiple BindingRequested events arrive in a single tick (= rare;
 * usually one DOM event per tick), the LAST one wins.
 */
export function createBindingSwapSystem(
  reg: Registry,
  catalog: ControllerBinding[],
): SystemDescriptor {
  return {
    id: BINDING_SWAP_SYSTEM_ID,
    description:
      "Drains BindingRequested events from the event buffer and applies the matching binding's paramOverrides via applyControllerBinding. UI dropdowns and scenario harnesses emit the event; this system is the consumer.",
    buffers: [
      { id: EVENT_BUFFER_ID, access: "readwrite" },
      { id: CONTROLLER_PARAMS_BUFFER_ID, access: "readwrite" },
    ],
    // Run after the SM has drained + processed its events so we
    // don't race for the events buffer. SM doesn't touch
    // BindingRequested events, so order is for hazard-validator only.
    runsAfter: ["stateMachineSystem"],
    execute: ({ buffer }) => {
      const events = buffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
      const all = readBuffer(events);
      // Collect BindingRequested events; keep the rest in the buffer.
      const surviving: RuntimeEvent[] = [];
      let last: string | null = null;
      for (const ev of all) {
        if (ev.type === "BindingRequested") {
          last = ev.payload.bindingId;
        } else {
          surviving.push(ev);
        }
      }
      if (last !== null) {
        writeBuffer(events, () => surviving);
        const target = catalog.find((b) => b.id === last);
        if (target) applyControllerBinding(reg, target);
        // Unknown id → silently ignored (= matches the SM's
        // onUnhandled "log + drop" semantic for unsupported events).
      }
    },
  };
}
