/**
 * Scenes as Modes.
 *
 * A scene is a registered Mode whose `systems` list matches the
 * gameplay graph (= shared by all scenes) but whose id, label, and
 * seedData differ per scene. Switching scenes = switching active
 * mode; the gameplay simulation reuses the same system graph (=
 * cached by `getOrBuildGraphForMode`) and a scene loader populates
 * the scene-specific buffers from seedData.
 *
 * This is the Phase 2 unblock for the modes-and-modules architecture
 * (see docs/modes-and-modules.md): once scenes are registered modes,
 * the cycling UI / library viewer treat them like any other mode.
 *
 * The bootstrap layer is responsible for discovering the available
 * scenes (= enumerate `public/maps/<name>/`) and calling this
 * function with the result + the canonical gameplay system list.
 * Tests use synthetic seeds + systems.
 */

import type { Registry } from "./registry";
import type { SystemId } from "./system";

export interface SceneModeSeed {
  /** Mode id (= scene name slug, e.g. "forest-clearing"). */
  id: string;
  /** Display name for the cycling UI. */
  label: string;
  /** Extra tags merged into the default ["scene"] (= e.g., ["gym"]). */
  tags?: string[];
  /** Optional per-scene seed data attached to the Mode's
   *  `seedBuffers` under the scene's own id key. A scene-loader
   *  system reads `mode.seedBuffers[mode.id]` on mode activation to
   *  decide what to load (= map name, asset list, FSM start state). */
  seedData?: unknown;
}

/**
 * Register a batch of scenes as Modes sharing `gameplaySystems`. Returns
 * the list of registered mode ids in input order. Each Mode is tagged
 * "scene" plus any per-seed tags. Throws on duplicate ids (= the
 * underlying ModeRegistry's behavior).
 */
export function registerSceneModes(
  reg: Registry,
  seeds: SceneModeSeed[],
  gameplaySystems: SystemId[],
): string[] {
  const ids: string[] = [];
  for (const seed of seeds) {
    const tags = ["scene", ...(seed.tags ?? [])];
    reg.registerMode({
      id: seed.id,
      label: seed.label,
      tags,
      systems: gameplaySystems,
      seedBuffers: seed.seedData !== undefined ? { [seed.id]: seed.seedData } : undefined,
    });
    ids.push(seed.id);
  }
  return ids;
}
