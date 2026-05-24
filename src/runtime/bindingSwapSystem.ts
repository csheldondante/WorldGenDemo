/**
 * BindingSwapSystem — handles `BindingRequested` events from the
 * event buffer by invoking an injected `apply` callback on the
 * matching binding from a runtime-provided catalog.
 *
 * The system is runtime-pure: it doesn't know which buffer the
 * binding installation writes to (= that's app-layer knowledge). The
 * caller passes both the apply callback AND the list of buffer ids
 * the callback writes to, so the hazard validator can do its job.
 */

import { readBuffer, writeBuffer, type BufferId } from "./buffer";
import type { SystemDescriptor } from "./system";
import type { ControllerBinding } from "./moduleSlots";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "./stateMachine";

export const BINDING_SWAP_SYSTEM_ID = "bindingSwapSystem";

export interface BindingSwapOptions {
  /** Catalog the system looks up incoming binding-ids against. Unknown
   *  ids are silently ignored. */
  catalog: ControllerBinding[];
  /** Function that installs the binding's slotData into runtime
   *  buffers. Injected by the caller (= app layer) so this system
   *  stays runtime-pure. */
  apply: (binding: ControllerBinding) => void;
  /** Buffer ids the `apply` callback writes to. Declared in the
   *  system's `buffers` access list so the graph hazard checker can
   *  detect conflicts with other writers/readers. */
  writeBufferIds: BufferId[];
  /** System ids that read the buffers `apply` writes to. Declared as
   *  `runsBefore` so the binding swap takes effect on the same tick.
   *  Caller-injected because the set is app-layer knowledge (= which
   *  systems read e.g. CharacterControllerProfileBuffer). */
  runsBefore?: string[];
}

/**
 * Factory for the BindingSwapSystem. Each tick drains `BindingRequested`
 * events from the event buffer; if the payload matches a catalog
 * binding, invokes `apply(binding)`. Unknown ids are silently ignored.
 *
 * If multiple BindingRequested events arrive in a single tick (= rare;
 * usually one DOM event per tick), the LAST one wins.
 */
export function createBindingSwapSystem(opts: BindingSwapOptions): SystemDescriptor {
  return {
    id: BINDING_SWAP_SYSTEM_ID,
    description:
      "Drains BindingRequested events from the event buffer and invokes an app-provided apply() callback on the matching binding. UI dropdowns and scenario harnesses emit the event; this system is the consumer. apply() installs the binding's slotData into the appropriate domain buffers (e.g., CharacterControllerProfileBuffer for the characterIntent slot).",
    buffers: [
      { id: EVENT_BUFFER_ID, access: "readwrite" },
      ...opts.writeBufferIds.map((id) => ({ id, access: "write" as const })),
    ],
    // Run after the SM has drained + processed its events so we
    // don't race for the events buffer. SM doesn't touch
    // BindingRequested events, so order is for hazard-validator only.
    runsAfter: ["stateMachineSystem"],
    // Run BEFORE any reader of the destination buffers so the swap
    // takes effect this tick (= caller-injected, since the runtime
    // layer doesn't know which app systems consume the slot data).
    runsBefore: opts.runsBefore,
    execute: ({ buffer }) => {
      const events = buffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
      const all = readBuffer(events);
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
        const target = opts.catalog.find((b) => b.id === last);
        if (target) opts.apply(target);
      }
    },
  };
}
