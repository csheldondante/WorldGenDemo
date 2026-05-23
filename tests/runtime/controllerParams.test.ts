import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  CONTROLLER_PARAMS_BUFFER_ID,
  createControllerParamsBuffer,
  applyControllerBinding,
  readSlotParams,
  type ControllerParamsBufferData,
} from "../../src/runtime/controllerParams";
import {
  createModuleRegistry,
  resolveBinding,
  type ControllerBinding,
} from "../../src/runtime/moduleSlots";
import { SLOT_CHARACTER_INTENT, SLOT_PHYSICS } from "../../src/runtime/slotIds";
import type { SystemDescriptor } from "../../src/runtime/system";

/**
 * Phase 4c: parameterized modules. A controller binding carries
 * `paramOverrides` per slot; `applyControllerBinding(reg, binding)`
 * writes them into the runtime's `ControllerParamsBuffer`. Modules
 * read their slot's params via `readSlotParams(ctx, slotId)` at
 * execute time.
 *
 * Demonstrates the user-articulated need (2026-05-23):
 *
 *   "yes bindings but also different parameter values for those
 *    bindings. some may be faster, accelerate more easily (more
 *    agile) or have different grip for example"
 *
 * Two bindings with identical modules but different paramOverrides
 * produce different outputs. Same gameplay loop; different "feel".
 */

interface OutputBufferData { speed: number; grip: number; }

/** A synthetic characterIntent module that reads speed + grip params and
 *  writes them to an output buffer. Used to verify that param overrides
 *  flow through `applyControllerBinding` into module execute(). */
function createIntentSystem(): SystemDescriptor {
  return {
    id: "test:characterIntent",
    description: "synthetic characterIntent reading speed + grip params",
    buffers: [
      { id: CONTROLLER_PARAMS_BUFFER_ID, access: "read" },
      { id: "output", access: "readwrite" },
    ],
    execute: ({ buffer }) => {
      const params = readSlotParams(
        readBuffer(buffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID)),
        SLOT_CHARACTER_INTENT,
      );
      const out = buffer<OutputBufferData>("output");
      writeBuffer(out, (d) => {
        d.speed = (params.speed as number | undefined) ?? 0;
        d.grip = (params.grip as number | undefined) ?? 0;
      });
    },
  };
}

describe("ControllerParams", () => {
  function setup() {
    const reg = createRegistry();
    reg.registerBuffer(createControllerParamsBuffer());
    reg.registerBuffer(createBuffer<OutputBufferData>({
      id: "output",
      description: "test output",
      initial: { speed: 0, grip: 0 },
    }));
    reg.registerSystem(createIntentSystem());
    return reg;
  }

  function runTick(reg: ReturnType<typeof setup>) {
    const g = buildExecutionGraph({
      id: "g",
      nodes: ["test:characterIntent"],
      registry: reg,
    });
    executeGraph(g, reg, { dt: 0, now: 0 });
  }

  it("applyControllerBinding writes paramOverrides into the buffer", () => {
    const reg = setup();
    const binding: ControllerBinding = {
      id: "biped-default",
      bindings: { [SLOT_CHARACTER_INTENT]: ["test:characterIntent"] },
      paramOverrides: {
        [SLOT_CHARACTER_INTENT]: { speed: 8, grip: 1.0 },
      },
    };
    applyControllerBinding(reg, binding);
    runTick(reg);
    const out = readBuffer(reg.getBuffer<OutputBufferData>("output"));
    expect(out.speed).toBe(8);
    expect(out.grip).toBe(1.0);
  });

  it("two bindings with the SAME module but different params give different outputs", () => {
    const reg = setup();
    const standard: ControllerBinding = {
      id: "biped-standard",
      bindings: { [SLOT_CHARACTER_INTENT]: ["test:characterIntent"] },
      paramOverrides: { [SLOT_CHARACTER_INTENT]: { speed: 8, grip: 1.0 } },
    };
    const agile: ControllerBinding = {
      id: "biped-agile",
      bindings: { [SLOT_CHARACTER_INTENT]: ["test:characterIntent"] },
      paramOverrides: { [SLOT_CHARACTER_INTENT]: { speed: 12, grip: 0.8 } },
    };

    applyControllerBinding(reg, standard);
    runTick(reg);
    const standardOut = { ...readBuffer(reg.getBuffer<OutputBufferData>("output")) };

    applyControllerBinding(reg, agile);
    runTick(reg);
    const agileOut = { ...readBuffer(reg.getBuffer<OutputBufferData>("output")) };

    expect(standardOut).toEqual({ speed: 8, grip: 1.0 });
    expect(agileOut).toEqual({ speed: 12, grip: 0.8 });
  });

  it("applyControllerBinding replaces previous params, doesn't merge", () => {
    const reg = setup();
    const first: ControllerBinding = {
      id: "first",
      bindings: { [SLOT_CHARACTER_INTENT]: ["test:characterIntent"] },
      paramOverrides: {
        [SLOT_CHARACTER_INTENT]: { speed: 5, grip: 2.0 },
        [SLOT_PHYSICS]: { dragCoeff: 0.1 },
      },
    };
    applyControllerBinding(reg, first);
    const second: ControllerBinding = {
      id: "second",
      bindings: { [SLOT_CHARACTER_INTENT]: ["test:characterIntent"] },
      paramOverrides: { [SLOT_CHARACTER_INTENT]: { speed: 9 } },  // no grip param, no physics slot
    };
    applyControllerBinding(reg, second);
    const params = readBuffer(reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID));
    expect(params.bySlot[SLOT_CHARACTER_INTENT]).toEqual({ speed: 9 });
    expect(params.bySlot[SLOT_PHYSICS]).toBeUndefined();
  });

  it("readSlotParams returns {} for a slot with no overrides", () => {
    const reg = setup();
    const minimal: ControllerBinding = {
      id: "minimal",
      bindings: { [SLOT_CHARACTER_INTENT]: ["test:characterIntent"] },
    };
    applyControllerBinding(reg, minimal);
    const params = readBuffer(reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID));
    expect(readSlotParams(params, SLOT_CHARACTER_INTENT)).toEqual({});
  });

  it("bindingId field on the buffer captures which binding is active", () => {
    const reg = setup();
    const binding: ControllerBinding = {
      id: "biped",
      bindings: { [SLOT_CHARACTER_INTENT]: ["test:characterIntent"] },
    };
    applyControllerBinding(reg, binding);
    const params = readBuffer(reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID));
    expect(params.bindingId).toBe("biped");
  });
});

describe("resolveBinding interplay with params", () => {
  it("resolveBinding returns systems; params live in the buffer separately", () => {
    // Confirms separation of concerns: resolveBinding gives you the
    // system list (= scheduler input); paramOverrides go into the
    // params buffer (= module input). They don't entangle.
    const reg = createModuleRegistry();
    const sysA: SystemDescriptor = { id: "a", description: "", buffers: [], execute: () => {} };
    reg.register({ id: "a", slotId: SLOT_CHARACTER_INTENT, system: sysA });
    const binding: ControllerBinding = {
      id: "b",
      bindings: { [SLOT_CHARACTER_INTENT]: ["a"] },
      paramOverrides: { [SLOT_CHARACTER_INTENT]: { speed: 99 } },
    };
    const systems = resolveBinding(reg, binding);
    expect(systems[0].id).toBe("a");
    // paramOverrides on the binding is unchanged + untouched by resolveBinding.
    expect(binding.paramOverrides![SLOT_CHARACTER_INTENT]).toEqual({ speed: 99 });
  });
});
