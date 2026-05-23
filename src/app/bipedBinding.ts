/**
 * Biped controller binding — Phase 4d of the modes-and-modules
 * refactor (see `docs/modes-and-modules.md`).
 *
 * Wraps the existing per-character systems as Modules tagged with
 * canonical slot ids, and assembles a "biped:default" Controller
 * Binding that the Running mode is built from. The systems referenced
 * are the same SystemDescriptors registered by `registerCoreSystems`
 * — no behavior change, only that the system list is now DERIVED
 * from the binding rather than hand-curated in `graphs.ts`.
 *
 * Future work:
 *   - Wrap the character systems in module factories that read
 *     `ControllerParamsBuffer` for tunable values (= agility, grip,
 *     max speed). Then a sibling binding "biped:agile" with different
 *     paramOverrides will produce a different feel without swapping
 *     module identities.
 *   - Sibling archetypes ("vehicle", "drone") provide different
 *     modules for the same slots.
 */

import { createModuleRegistry, type ControllerBinding, type ModuleRegistry } from "../runtime/moduleSlots";
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
} from "../runtime/slotIds";
import type { Registry } from "../runtime/registry";

// System ids — sourced from the existing system modules so we
// share single source of truth.
import { INPUT_SYSTEM_ID } from "../systems/input";
import { INPUT_MAPPER_SYSTEM_ID } from "../systems/inputMapper";
import { CHARACTER_INPUT_SYSTEM_ID } from "../systems/characterInput";
import { TANGENT_INPUT_MAPPER_SYSTEM_ID } from "../systems/tangentInputMapper";
import { CHARACTER_ORIENTATION_SYSTEM_ID } from "../systems/characterOrientation";
import { FORCE_FIELD_SYSTEM_ID } from "../systems/forceField";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "../systems/characterController";
import { SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID } from "../systems/surfaceConstrainedVelocity";
import { VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID } from "../systems/volumetricConstrainedVelocity";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "../systems/surfaceConstraint";
import { CAMERA_PIVOT_SYSTEM_ID } from "../systems/cameraPivot";
import { CAMERA_ORBIT_SYSTEM_ID } from "../systems/cameraOrbit";
import { CHARACTER_RENDER_SYNC_SYSTEM_ID } from "../systems/characterRenderSync";
import { BODY_LEAN_SYSTEM_ID } from "../systems/bodyLean";
import { CHAIN_DYNAMICS_SYSTEM_ID } from "../systems/chainDynamics";
import { FOOT_PLANNER_SYSTEM_ID } from "../systems/footPlanner";
import { FOOT_IK_SYSTEM_ID } from "../systems/footIk";
import { SKELETON_WORLD_SYSTEM_ID } from "../systems/skeletonWorld";
import { SKELETON_DEBUG_RENDER_SYSTEM_ID } from "../systems/skeletonDebugRender";

export const BIPED_DEFAULT_BINDING_ID = "biped:default";

/**
 * Per-slot system-id assignment for the biped archetype. The Phase 4d
 * mapping wraps existing per-frame character systems with slot tags;
 * the underlying SystemDescriptors are unchanged.
 *
 * Each entry's ORDER within a slot is preserved by `resolveBinding`;
 * `buildExecutionGraph` then topo-sorts by declared dependencies, so
 * the final tick order matches what the legacy Running graph produced.
 */
const BIPED_DEFAULT_SLOT_ASSIGNMENTS = {
  [SLOT_INPUT_NORMALIZATION]: [INPUT_SYSTEM_ID],
  [SLOT_INPUT_SEMANTIC_MAPPING]: [INPUT_MAPPER_SYSTEM_ID, CHARACTER_INPUT_SYSTEM_ID],
  [SLOT_CAMERA_INTENT]: [CAMERA_PIVOT_SYSTEM_ID],
  [SLOT_CHARACTER_INTENT]: [TANGENT_INPUT_MAPPER_SYSTEM_ID],
  [SLOT_CAMERA_UPDATE]: [CAMERA_ORBIT_SYSTEM_ID],
  [SLOT_COLLISION]: [SURFACE_CONSTRAINT_SYSTEM_ID],
  [SLOT_CHARACTER_UPDATE]: [
    CHARACTER_ORIENTATION_SYSTEM_ID,
    CHARACTER_CONTROLLER_SYSTEM_ID,
    SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID,
    VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID,
  ],
  [SLOT_PHYSICS]: [FORCE_FIELD_SYSTEM_ID],
  [SLOT_ANIMATION]: [
    BODY_LEAN_SYSTEM_ID,
    CHAIN_DYNAMICS_SYSTEM_ID,
    FOOT_PLANNER_SYSTEM_ID,
    FOOT_IK_SYSTEM_ID,
    SKELETON_WORLD_SYSTEM_ID,
    CHARACTER_RENDER_SYNC_SYSTEM_ID,
    SKELETON_DEBUG_RENDER_SYSTEM_ID,
  ],
} as const;

/**
 * Register a Module for every system in the biped binding's slot
 * assignments. Each Module's id is `${BIPED_DEFAULT_BINDING_ID}:${systemId}`
 * so it's globally unique and sibling archetypes (= "vehicle:default")
 * can use the same system from a different module id.
 *
 * Requires `registerCoreSystems` to have already registered the system
 * descriptors. Returns the resulting biped binding.
 */
export function registerBipedDefaultBinding(reg: Registry): {
  binding: ControllerBinding;
  moduleRegistry: ModuleRegistry;
} {
  const moduleRegistry = createModuleRegistry();
  const bindings: Record<string, string[]> = {};

  for (const [slotId, systemIds] of Object.entries(BIPED_DEFAULT_SLOT_ASSIGNMENTS)) {
    bindings[slotId] = [];
    for (const sysId of systemIds) {
      const moduleId = `${BIPED_DEFAULT_BINDING_ID}:${sysId}`;
      const system = reg.getSystem(sysId); // throws if not registered
      moduleRegistry.register({ id: moduleId, slotId, system });
      bindings[slotId].push(moduleId);
    }
  }

  const binding: ControllerBinding = {
    id: BIPED_DEFAULT_BINDING_ID,
    bindings,
  };
  return { binding, moduleRegistry };
}

/**
 * Derive the legacy "Running" mode's CHARACTER system ids from the
 * biped binding's slot assignments. Used by `buildAndRegisterCoreGraphs`
 * to construct the Running graph's nodes list from the binding rather
 * than hand-curating the system ids.
 *
 * The result excludes runtime infrastructure systems (stateMachine,
 * inputRecording, debugGizmo) and render systems (render, minimap,
 * hud) — those are added by the Running mode builder separately.
 */
export function bipedDefaultSystemIds(): string[] {
  const out: string[] = [];
  for (const list of Object.values(BIPED_DEFAULT_SLOT_ASSIGNMENTS)) {
    for (const sysId of list) out.push(sysId);
  }
  return out;
}

/** Re-export for tests / inspection — not for runtime consumers. */
export const BIPED_DEFAULT_SLOT_ASSIGNMENTS_FOR_TESTS = BIPED_DEFAULT_SLOT_ASSIGNMENTS;
