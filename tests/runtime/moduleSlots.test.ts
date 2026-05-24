import { describe, it, expect } from "vitest";
import {
  createModuleRegistry,
  resolveBinding,
  type Module,
  type ControllerBinding,
} from "../../src/runtime/moduleSlots";
import type { SystemDescriptor } from "../../src/runtime/system";

/**
 * Phase 4a of the modes-and-modules refactor.
 *
 * A character controller decomposes into module SLOTS:
 *   inputNormalization, inputSemanticMapping, cameraIntent,
 *   characterIntent, cameraUpdate, collision, characterUpdate,
 *   physics, animation.
 *
 * A MODULE is an implementation of one slot (= a SystemDescriptor
 * tagged with the slot id + optional param schema).
 *
 * A CONTROLLER BINDING is a per-archetype map of slot → module id (=
 * "biped", "vehicle", "drone"). Different bindings instantiate
 * different gameplay feel from the same slot interface set.
 *
 * Phase 4a wires the registry + binding-resolution mechanism; existing
 * character systems are NOT yet refactored to fit slot boundaries. That
 * happens in phase 4b (per-slot id constants + module wrappers around
 * existing systems) and phase 4c (the actual character-controller
 * refactor consuming a binding).
 */

function syntheticSystem(id: string): SystemDescriptor {
  return { id, description: id, buffers: [], execute: () => {} };
}

describe("ModuleRegistry", () => {
  it("registers and retrieves modules by id", () => {
    const reg = createModuleRegistry();
    const mod: Module = {
      id: "biped:characterIntent",
      slotId: "characterIntent",
      system: syntheticSystem("biped:characterIntent"),
    };
    reg.register(mod);
    expect(reg.get("biped:characterIntent")).toBe(mod);
    expect(reg.has("biped:characterIntent")).toBe(true);
  });

  it("rejects duplicate module ids", () => {
    const reg = createModuleRegistry();
    reg.register({ id: "x", slotId: "s", system: syntheticSystem("x") });
    expect(() =>
      reg.register({ id: "x", slotId: "s", system: syntheticSystem("x") }),
    ).toThrow(/already registered/);
  });

  it("lists modules by slot id", () => {
    const reg = createModuleRegistry();
    reg.register({ id: "biped:intent", slotId: "characterIntent", system: syntheticSystem("biped:intent") });
    reg.register({ id: "vehicle:intent", slotId: "characterIntent", system: syntheticSystem("vehicle:intent") });
    reg.register({ id: "biped:physics", slotId: "physics", system: syntheticSystem("biped:physics") });
    const intents = reg.listBySlot("characterIntent").map((m) => m.id).sort();
    expect(intents).toEqual(["biped:intent", "vehicle:intent"]);
    expect(reg.listBySlot("physics").map((m) => m.id)).toEqual(["biped:physics"]);
    expect(reg.listBySlot("nonexistent")).toEqual([]);
  });
});

describe("resolveBinding", () => {
  function setup() {
    const reg = createModuleRegistry();
    reg.register({ id: "biped:intent", slotId: "characterIntent", system: syntheticSystem("biped:intent") });
    reg.register({ id: "vehicle:intent", slotId: "characterIntent", system: syntheticSystem("vehicle:intent") });
    reg.register({ id: "biped:phys", slotId: "physics", system: syntheticSystem("biped:phys") });
    reg.register({ id: "shared:phys", slotId: "physics", system: syntheticSystem("shared:phys") });
    return reg;
  }

  it("returns the system descriptors for each slot binding (insertion-order array)", () => {
    const reg = setup();
    const binding: ControllerBinding = {
      id: "biped",
      bindings: {
        characterIntent: ["biped:intent"],
        physics: ["biped:phys"],
      },
    };
    const systems = resolveBinding(reg, binding);
    expect(systems.map((s) => s.id)).toEqual(["biped:intent", "biped:phys"]);
  });

  it("two distinct bindings can swap one slot's module while sharing others", () => {
    const reg = setup();
    const biped: ControllerBinding = {
      id: "biped",
      bindings: { characterIntent: ["biped:intent"], physics: ["shared:phys"] },
    };
    const vehicle: ControllerBinding = {
      id: "vehicle",
      bindings: { characterIntent: ["vehicle:intent"], physics: ["shared:phys"] },
    };
    const bipedSystems = resolveBinding(reg, biped);
    const vehicleSystems = resolveBinding(reg, vehicle);
    // Different intent systems...
    expect(bipedSystems.find((s) => s.id === "biped:intent")).toBeDefined();
    expect(vehicleSystems.find((s) => s.id === "vehicle:intent")).toBeDefined();
    // ...but the same physics system instance.
    const bipedPhys = bipedSystems.find((s) => s.id === "shared:phys");
    const vehiclePhys = vehicleSystems.find((s) => s.id === "shared:phys");
    expect(bipedPhys).toBe(vehiclePhys);
  });

  it("throws on a missing module id in the binding", () => {
    const reg = setup();
    const binding: ControllerBinding = {
      id: "broken",
      bindings: { characterIntent: ["ghost-module"] },
    };
    expect(() => resolveBinding(reg, binding)).toThrow(/ghost-module/);
  });

  it("throws when the binding's module id resolves to the wrong slot", () => {
    const reg = setup();
    const binding: ControllerBinding = {
      id: "mismatched",
      // physics module bound under characterIntent slot
      bindings: { characterIntent: ["biped:phys"] },
    };
    expect(() => resolveBinding(reg, binding)).toThrow(/slot/i);
  });

  it("carries slotData per slot (= installer-shaped data for binding application)", () => {
    const reg = setup();
    // Refactored 2026-05-23: paramOverrides → slotData. The data is
    // opaque to the runtime (interpreted by applyControllerBinding in
    // src/app/applyControllerBinding.ts per slot). See
    // wiki/worldgen-demo-bindings-install-profiles-not-multipliers.
    const binding: ControllerBinding = {
      id: "biped",
      bindings: { characterIntent: ["biped:intent"], physics: ["biped:phys"] },
      slotData: { characterIntent: { profileShape: "test-marker" } },
    };
    expect(binding.slotData?.characterIntent).toEqual({ profileShape: "test-marker" });
    const systems = resolveBinding(reg, binding);
    expect(systems.length).toBe(2);
  });
});
