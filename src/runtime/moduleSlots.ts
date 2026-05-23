/**
 * Module slots — Phase 4 of the modes-and-modules refactor (see
 * `docs/modes-and-modules.md`).
 *
 * The character controller decomposes into named slots; each slot has
 * an interface contract (= which buffers a module is expected to
 * read/write). A MODULE is one implementation of one slot; a
 * CONTROLLER BINDING is a per-archetype map of slot → module id
 * (biped, vehicle, drone). The runtime resolves a binding into a flat
 * list of SystemDescriptors that the gameplay graph runs each tick.
 *
 * Slot ids (canonical, ordered by tick flow):
 *
 *   inputNormalization  — raw devices → normalized values.
 *   inputSemanticMapping — normalized → semantic actions.
 *   cameraIntent        — semantic input + camera state → camera intent.
 *   characterIntent     — semantic input + camera basis + surface → char intent.
 *   cameraUpdate        — camera intent → camera transform.
 *   collision           — body + velocity + surface → contact + events.
 *   characterUpdate     — char intent + collision + FSM → new char state.
 *   physics             — gravity + external forces → integration.
 *   animation           — root motion + skeleton → segment transforms.
 *
 * These slot ids are declared in Phase 4b (= `src/runtime/slotIds.ts`)
 * once existing systems are wrapped as modules for each slot. Phase 4a
 * (this file) provides only the registry + binding-resolution mechanism.
 */

import type { SystemDescriptor } from "./system";

/** Stable slot identifier (= "characterIntent", "physics", etc.). */
export type SlotId = string;

/** Stable module identifier (= "biped:characterIntent", "vehicle:physics"). */
export type ModuleId = string;

/**
 * An implementation of one slot. `slotId` is the contract the module
 * promises to fulfill; `system` is the executable. `paramSchema` is
 * optional JSON schema describing tunable parameters (= consumed by
 * the future debug-gym clone-and-tweak overlay).
 */
export interface Module {
  id: ModuleId;
  slotId: SlotId;
  system: SystemDescriptor;
  /** Optional JSON-schema-shaped description of tunable parameters.
   *  Future debug-gym UI reads this to build live-editor widgets. */
  paramSchema?: unknown;
}

/**
 * A controller archetype's binding from slot → module list. Different
 * bindings (biped, vehicle, drone) instantiate different gameplay
 * feel from the same slot interface set.
 *
 * A slot can have MULTIPLE modules — e.g., the `animation` slot for a
 * biped runs body-lean + chain-dynamics + foot-planner + foot-ik +
 * skeleton-world together; each is a separate Module registered under
 * SLOT_ANIMATION. The list order within a slot is preserved (= passed
 * to `buildExecutionGraph` which topo-sorts respecting runsAfter).
 *
 * `paramOverrides` carries per-slot parameter values that override
 * module defaults; the active character system reads these to
 * configure module behavior at runtime. Per-slot, not per-module —
 * modules in the same slot share the slot's param object.
 */
export interface ControllerBinding {
  id: string;
  bindings: Record<SlotId, ModuleId[]>;
  paramOverrides?: Record<SlotId, Record<string, unknown>>;
}

export interface ModuleRegistry {
  register(mod: Module): void;
  get(id: ModuleId): Module | undefined;
  has(id: ModuleId): boolean;
  /** All modules registered against the given slot. Empty array if
   *  no modules match. Insertion order. */
  listBySlot(slotId: SlotId): Module[];
}

export function createModuleRegistry(): ModuleRegistry {
  const modules = new Map<ModuleId, Module>();
  const insertion: ModuleId[] = [];
  return {
    register(mod: Module): void {
      if (modules.has(mod.id)) {
        throw new Error(`ModuleRegistry: module '${mod.id}' is already registered.`);
      }
      modules.set(mod.id, mod);
      insertion.push(mod.id);
    },
    get(id): Module | undefined {
      return modules.get(id);
    },
    has(id): boolean {
      return modules.has(id);
    },
    listBySlot(slotId: SlotId): Module[] {
      return insertion
        .map((id) => modules.get(id)!)
        .filter((m) => m.slotId === slotId);
    },
  };
}

/**
 * Resolve a binding into the flat list of `SystemDescriptor`s the
 * gameplay graph should run. Slot order is determined by the
 * binding's `bindings` object insertion order; within a slot,
 * `bindings[slot]` array order is preserved. `buildExecutionGraph`
 * then topo-sorts respecting each module's declared `runsAfter`.
 *
 * Throws if:
 *   - a binding references an unregistered module id;
 *   - the resolved module's `slotId` doesn't match the binding's slot
 *     key (= protects against accidentally binding a physics module
 *     under the characterIntent slot).
 */
export function resolveBinding(reg: ModuleRegistry, binding: ControllerBinding): SystemDescriptor[] {
  const out: SystemDescriptor[] = [];
  for (const [slotId, moduleIds] of Object.entries(binding.bindings)) {
    for (const moduleId of moduleIds) {
      const mod = reg.get(moduleId);
      if (!mod) {
        throw new Error(
          `resolveBinding: binding '${binding.id}' references unregistered module '${moduleId}' for slot '${slotId}'.`,
        );
      }
      if (mod.slotId !== slotId) {
        throw new Error(
          `resolveBinding: binding '${binding.id}' slot '${slotId}' points to module '${moduleId}' which is registered under slot '${mod.slotId}' (slot mismatch).`,
        );
      }
      out.push(mod.system);
    }
  }
  return out;
}
