import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer } from "../../src/runtime/buffer";
import { registerCoreBuffers } from "../../src/buffers";
import { registerCoreSystems } from "../../src/systems";
import { buildAndRegisterCoreGraphs } from "../../src/app/graphs";
import { registerInfrastructureSystems } from "../../src/runtime/infrastructureSystems";
import { registerBipedDefaultBinding } from "../../src/app/bipedBinding";
import {
  BIPED_STANDARD,
  BIPED_AGILE,
  BIPED_HEAVY,
  CHARACTER_BINDINGS,
  materializeBindings,
} from "../../src/app/characterBindings";
import {
  applyControllerBinding,
  createControllerParamsBuffer,
  CONTROLLER_PARAMS_BUFFER_ID,
  type ControllerParamsBufferData,
} from "../../src/runtime/controllerParams";
import { SLOT_CHARACTER_INTENT, SLOT_PHYSICS } from "../../src/runtime/slotIds";

/**
 * Phase 5 — multiple character bindings sharing modules but carrying
 * different paramOverrides (= "some may be faster, accelerate more
 * easily, have different grip", per user 2026-05-23).
 *
 * These tests verify the catalog SHAPE + the binding-swap mechanism.
 * The visible-behavior demo (= systems reading ControllerParamsBuffer
 * to change actual character feel) is Phase 5b — deferred until at
 * least one existing system is refactored to consume the buffer.
 */

describe("Character bindings catalog", () => {
  it("includes standard, agile, heavy bindings", () => {
    const ids = CHARACTER_BINDINGS.map((b) => b.id);
    expect(ids).toEqual(["biped:standard", "biped:agile", "biped:heavy"]);
  });

  it("agile has faster speed + lower grip than standard", () => {
    const standard = BIPED_STANDARD.paramOverrides![SLOT_CHARACTER_INTENT];
    const agile = BIPED_AGILE.paramOverrides![SLOT_CHARACTER_INTENT];
    expect((agile.speedMultiplier as number)).toBeGreaterThan(standard.speedMultiplier as number);
    expect((agile.gripMultiplier as number)).toBeLessThan(standard.gripMultiplier as number);
  });

  it("heavy has slower speed + higher grip than standard", () => {
    const standard = BIPED_STANDARD.paramOverrides![SLOT_CHARACTER_INTENT];
    const heavy = BIPED_HEAVY.paramOverrides![SLOT_CHARACTER_INTENT];
    expect((heavy.speedMultiplier as number)).toBeLessThan(standard.speedMultiplier as number);
    expect((heavy.gripMultiplier as number)).toBeGreaterThan(standard.gripMultiplier as number);
  });

  it("materializeBindings merges biped:default slot assignments into every catalog binding", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg);
    buildAndRegisterCoreGraphs(reg);
    const { binding: bipedDefault } = registerBipedDefaultBinding(reg);

    const materialized = materializeBindings(bipedDefault);
    expect(materialized.length).toBe(CHARACTER_BINDINGS.length);
    for (const m of materialized) {
      // Slot assignments come from biped:default.
      expect(m.bindings).toEqual(bipedDefault.bindings);
      // But the per-binding paramOverrides are preserved.
      const orig = CHARACTER_BINDINGS.find((b) => b.id === m.id)!;
      expect(m.paramOverrides).toEqual(orig.paramOverrides);
    }
  });

  it("applyControllerBinding swap from standard → agile updates ControllerParamsBuffer", () => {
    const reg = createRegistry();
    reg.registerBuffer(createControllerParamsBuffer());

    // Use the test-only buffer; doesn't need the full bootstrap.
    applyControllerBinding(reg, BIPED_STANDARD);
    let params = readBuffer(reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID));
    expect(params.bindingId).toBe("biped:standard");
    expect(params.bySlot[SLOT_CHARACTER_INTENT]).toEqual({ speedMultiplier: 1.0, gripMultiplier: 1.0 });

    applyControllerBinding(reg, BIPED_AGILE);
    params = readBuffer(reg.getBuffer<ControllerParamsBufferData>(CONTROLLER_PARAMS_BUFFER_ID));
    expect(params.bindingId).toBe("biped:agile");
    expect(params.bySlot[SLOT_CHARACTER_INTENT]).toEqual({ speedMultiplier: 1.6, gripMultiplier: 0.7 });
    expect(params.bySlot[SLOT_PHYSICS]).toEqual({ dragMultiplier: 0.8 });
  });
});
