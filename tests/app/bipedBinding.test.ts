import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { registerCoreBuffers } from "../../src/buffers";
import { registerCoreSystems } from "../../src/systems";
import { buildAndRegisterCoreGraphs, RUNNING_GRAPH_ID } from "../../src/app/graphs";
import { registerInfrastructureSystems } from "../../src/runtime/infrastructureSystems";
import { createTransitionActivatorSystem } from "../../src/app/transitionActivator";
import {
  registerBipedDefaultBinding,
  bipedDefaultSystemIds,
  BIPED_DEFAULT_BINDING_ID,
} from "../../src/app/bipedBinding";
import { resolveBinding } from "../../src/runtime/moduleSlots";
import {
  SLOT_INPUT_NORMALIZATION,
  SLOT_INPUT_SEMANTIC_MAPPING,
  SLOT_CAMERA_INTENT,
  SLOT_CHARACTER_INTENT,
  SLOT_CAMERA_UPDATE,
  SLOT_COLLISION,
  SLOT_CHARACTER_UPDATE,
  SLOT_PHYSICS,
  SLOT_ANIMATION,
} from "../../src/runtime/slotIds";

/**
 * Phase 4d — biped binding wires per-slot existing character systems
 * into a ControllerBinding. Behavior is preserved:
 *
 *   - `resolveBinding(biped)` returns the same SystemDescriptors as the
 *     hand-curated Running graph's character-systems subset.
 *   - The Running graph CONTAINS every system in the binding (plus
 *     runtime + render systems the binding doesn't cover).
 *
 * The wired behavior is verified by the existing scenario baselines —
 * if any per-system identity changed, the snapshot comparator would
 * surface it. Tests here add explicit invariants on top.
 */

describe("Biped default binding", () => {
  function setup() {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg, { extraSystems: [createTransitionActivatorSystem()] });
    buildAndRegisterCoreGraphs(reg);
    const result = registerBipedDefaultBinding(reg);
    return { reg, ...result };
  }

  it("registers a module for every system in the binding (= slot tag matches)", () => {
    const { moduleRegistry, binding } = setup();
    for (const [slotId, moduleIds] of Object.entries(binding.bindings)) {
      for (const modId of moduleIds) {
        const mod = moduleRegistry.get(modId);
        expect(mod).toBeDefined();
        expect(mod!.slotId).toBe(slotId);
      }
    }
  });

  it("covers all 9 canonical slot ids", () => {
    const { binding } = setup();
    const slots = Object.keys(binding.bindings).sort();
    expect(slots).toEqual([
      SLOT_ANIMATION,
      SLOT_CAMERA_INTENT,
      SLOT_CAMERA_UPDATE,
      SLOT_CHARACTER_INTENT,
      SLOT_CHARACTER_UPDATE,
      SLOT_COLLISION,
      SLOT_INPUT_NORMALIZATION,
      SLOT_INPUT_SEMANTIC_MAPPING,
      SLOT_PHYSICS,
    ]);
  });

  it("resolveBinding produces the same SystemDescriptors as the registry's hand-registered systems", () => {
    const { reg, binding, moduleRegistry } = setup();
    const systems = resolveBinding(moduleRegistry, binding);
    // Each returned descriptor is the EXACT instance the registry
    // already has — no copy / wrapper introduced by Phase 4d.
    for (const sys of systems) {
      expect(reg.getSystem(sys.id)).toBe(sys);
    }
  });

  it("bipedDefaultSystemIds is a subset of the Running graph's nodes", () => {
    const { reg } = setup();
    const bipedIds = new Set(bipedDefaultSystemIds());
    const running = reg.getGraph(RUNNING_GRAPH_ID);
    for (const id of bipedIds) {
      expect(running.nodes).toContain(id);
    }
  });

  it("the runtime systems NOT in the biped binding are the runtime/render/debug systems", () => {
    const { reg } = setup();
    const bipedIds = new Set(bipedDefaultSystemIds());
    const running = reg.getGraph(RUNNING_GRAPH_ID);
    const notInBiped = running.nodes.filter((id) => !bipedIds.has(id));
    // Expected non-character systems in the Running graph. If this set
    // changes, this test catches it — that's a signal that the biped
    // binding may need to grow (= a new character system) or that a
    // new runtime/render system was added (= update the expected set).
    expect(notInBiped.sort()).toEqual([
      "bindingSwapSystem",
      "debugGizmoSystem",
      "hudSystem",
      "inputRecordingSystem",
      "minimapSystem",
      "overlayVisibilitySystem",
      "renderSystem",
      "stateMachineSystem",
    ]);
  });

  it("each biped module id is namespaced by the binding id", () => {
    const { binding } = setup();
    for (const moduleIds of Object.values(binding.bindings)) {
      for (const modId of moduleIds) {
        expect(modId.startsWith(`${BIPED_DEFAULT_BINDING_ID}:`)).toBe(true);
      }
    }
  });
});
