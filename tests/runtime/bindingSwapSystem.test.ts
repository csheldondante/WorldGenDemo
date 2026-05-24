import { describe, it, expect, vi } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  BINDING_SWAP_SYSTEM_ID,
  createBindingSwapSystem,
} from "../../src/runtime/bindingSwapSystem";
import {
  EVENT_BUFFER_ID,
  type RuntimeEvent,
} from "../../src/runtime/stateMachine";
import type { ControllerBinding } from "../../src/runtime/moduleSlots";

/**
 * BindingSwapSystem drains `BindingRequested` events from the event
 * buffer and invokes a caller-injected `apply` callback on the matching
 * binding. The runtime layer doesn't know about specific destination
 * buffers; the app layer's installer does the actual write (see
 * src/app/applyControllerBinding.ts).
 *
 * Refactored 2026-05-23 — the prior contract leaned on the deprecated
 * ControllerParamsBuffer + paramOverrides shape. See
 * wiki/worldgen-demo-bindings-install-profiles-not-multipliers.
 */

describe("BindingSwapSystem", () => {
  function setup() {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer<RuntimeEvent[]>({
      id: EVENT_BUFFER_ID,
      description: "events",
      initial: [],
    }));
    const standard: ControllerBinding = {
      id: "biped:standard",
      bindings: {},
      slotData: { characterIntent: { tag: "standard" } },
    };
    const agile: ControllerBinding = {
      id: "biped:agile",
      bindings: {},
      slotData: { characterIntent: { tag: "agile" } },
    };
    const catalog = [standard, agile];
    const apply = vi.fn();
    reg.registerSystem(createBindingSwapSystem({
      catalog,
      apply,
      writeBufferIds: [], // no real destination in this unit test
    }));
    return { reg, catalog, apply };
  }

  function tick(reg: ReturnType<typeof setup>["reg"]) {
    const g = buildExecutionGraph({
      id: "g",
      nodes: [BINDING_SWAP_SYSTEM_ID],
      registry: reg,
    });
    executeGraph(g, reg, { dt: 0, now: 0 });
  }

  it("invokes apply(binding) when a BindingRequested event is drained", () => {
    const { reg, apply, catalog } = setup();
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:agile" } });
    });
    tick(reg);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(catalog[1]);
  });

  it("drains the BindingRequested event after handling it", () => {
    const { reg } = setup();
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:agile" } });
    });
    tick(reg);
    const remaining = readBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID));
    expect(remaining.find((e) => e.type === "BindingRequested")).toBeUndefined();
  });

  it("preserves non-BindingRequested events in the buffer", () => {
    const { reg } = setup();
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:agile" } });
      d.push({ type: "WorldReady" });
    });
    tick(reg);
    const remaining = readBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID));
    expect(remaining.find((e) => e.type === "WorldReady")).toBeDefined();
  });

  it("ignores BindingRequested for unknown binding ids (= no throw, no apply call)", () => {
    const { reg, apply } = setup();
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:ghost" } });
    });
    expect(() => tick(reg)).not.toThrow();
    expect(apply).not.toHaveBeenCalled();
  });

  it("uses the LAST BindingRequested event when multiple arrive in one tick", () => {
    const { reg, apply, catalog } = setup();
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:standard" } });
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:agile" } });
    });
    tick(reg);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(catalog[1]); // agile
  });
});
