import { describe, it, expect } from "vitest";
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
import {
  CONTROLLER_PARAMS_BUFFER_ID,
  createControllerParamsBuffer,
  type ControllerParamsBufferData,
} from "../../src/runtime/controllerParams";
import {
  SLOT_CHARACTER_INTENT,
  SLOT_PHYSICS,
} from "../../src/runtime/slotIds";
import type { ControllerBinding } from "../../src/runtime/moduleSlots";

/**
 * Tech-debt payoff 2026-05-23: BindingSwapSystem drains
 * `BindingRequested` events from the event buffer and applies the
 * referenced binding via `applyControllerBinding`. Replaces direct
 * imperative calls from the binding-picker UI.
 */

describe("BindingSwapSystem", () => {
  function setup() {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer<RuntimeEvent[]>({
      id: EVENT_BUFFER_ID,
      description: "events",
      initial: [],
    }));
    reg.registerBuffer(createControllerParamsBuffer());
    const standard: ControllerBinding = {
      id: "biped:standard",
      bindings: {},
      paramOverrides: {
        [SLOT_CHARACTER_INTENT]: { speedMultiplier: 1.0 },
        [SLOT_PHYSICS]: { dragMultiplier: 1.0 },
      },
    };
    const agile: ControllerBinding = {
      id: "biped:agile",
      bindings: {},
      paramOverrides: {
        [SLOT_CHARACTER_INTENT]: { speedMultiplier: 1.6 },
        [SLOT_PHYSICS]: { dragMultiplier: 0.8 },
      },
    };
    const catalog = [standard, agile];
    reg.registerSystem(createBindingSwapSystem(reg, catalog));
    return { reg, catalog };
  }

  function tick(reg: ReturnType<typeof setup>["reg"]) {
    const g = buildExecutionGraph({
      id: "g",
      nodes: [BINDING_SWAP_SYSTEM_ID],
      registry: reg,
    });
    executeGraph(g, reg, { dt: 0, now: 0 });
  }

  it("applies the requested binding when a BindingRequested event is drained", () => {
    const { reg } = setup();
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:agile" } });
    });
    tick(reg);
    const params = readBuffer(reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID));
    expect(params.bindingId).toBe("biped:agile");
    expect(params.bySlot[SLOT_CHARACTER_INTENT]).toEqual({ speedMultiplier: 1.6 });
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

  it("ignores BindingRequested for unknown binding ids (= no throw, no state change)", () => {
    const { reg } = setup();
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:ghost" } });
    });
    expect(() => tick(reg)).not.toThrow();
    const params = readBuffer(reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID));
    expect(params.bindingId).toBe("");  // unchanged from initial
  });

  it("uses the LAST BindingRequested event when multiple arrive in one tick", () => {
    const { reg } = setup();
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:standard" } });
      d.push({ type: "BindingRequested", payload: { bindingId: "biped:agile" } });
    });
    tick(reg);
    expect(readBuffer(reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID)).bindingId).toBe("biped:agile");
  });
});
