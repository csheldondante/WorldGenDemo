/**
 * Modes — the runtime's top-level abstraction over `(active buffer set,
 * active system graph)`.
 *
 * Each Mode is a named configuration of systems. The execution graph is
 * DERIVED from `mode.systems` plus each system's declared dependencies
 * (`runsAfter` + buffer read/write hazards) via `buildExecutionGraph`.
 * We never store the graph; it's always a derived value. This means:
 *
 *   - Mode definitions are pure data (no graph instances embedded).
 *   - Adding a new system anywhere in the registry doesn't perturb
 *     existing modes (= they don't reference it).
 *   - Save/load is `{modeId, buffersJson}`; the graph regenerates on
 *     activation against the current registry.
 *
 * Subsequent phases generalize the State Machine to read `activeMode`
 * (= mode id) instead of the current hardcoded enum, and add mode
 * cycling UI, transitions, and per-character module slots.
 *
 * See `docs/modes-and-modules.md` for the full architectural target.
 */

import type { SystemId } from "./system";
import type { BufferId } from "./buffer";
import type { ExecutionGraph } from "./graph";
import { buildExecutionGraph } from "./graph";
import type { Registry } from "./registry";

export interface Mode {
  /** Stable unique id used for activeMode lookup. */
  id: string;
  /** Display name shown in the cycling UI. */
  label: string;
  /** Optional metadata for filtering/searching (e.g. "scene", "menu",
   *  "debug", "editor"). */
  tags?: string[];

  /** System IDs comprising this mode's tick graph. The actual
   *  `ExecutionGraph` is regenerated from this list at mode-activation
   *  time via `buildExecutionGraph` — we don't store or serialize the
   *  graph. */
  systems: SystemId[];

  /** Buffers scoped to this mode's lifetime (= candidates for reset on
   *  exit; informational for now). */
  ownedBuffers?: BufferId[];
  /** Buffers that persist across mode switches (= input devices,
   *  active character transform, etc.; informational for now). */
  sharedBuffers?: BufferId[];
}

export interface ModeListFilter {
  /** Match modes whose tags include ALL of these. */
  tags?: string[];
  /** Case-insensitive substring search against `id` and `label`. */
  search?: string;
}

export interface ModeRegistry {
  /** Add a mode. Throws if a mode with the same id is already
   *  registered (= prevents accidental shadowing). */
  register(mode: Mode): void;
  /** Look up a mode by id. */
  get(id: string): Mode | undefined;
  /** True iff a mode with the id is registered. */
  has(id: string): boolean;
  /** All registered modes, optionally filtered. Caller receives a
   *  fresh array each call (mutations don't affect the registry). */
  list(filter?: ModeListFilter): Mode[];
}

/**
 * Cache of mode-id → derived ExecutionGraph, keyed by the registry
 * instance. Each registry has its own cache; clearing happens when the
 * registry is garbage-collected.
 *
 * The cache invariant: `cache.get(reg).get(modeId)` is the graph built
 * from `reg.getMode(modeId)!.systems` via buildExecutionGraph. If a
 * mode's `systems` list changes after first activation (= not currently
 * supported), the cache will be stale; this is an explicit non-goal for
 * Phase 1b — modes are treated as immutable post-registration.
 */
const graphCacheByRegistry = new WeakMap<Registry, Map<string, ExecutionGraph>>();

/**
 * Look up (or build + cache) the ExecutionGraph derived from a mode's
 * `systems` list. The graph is regenerated from declared system
 * dependencies via `buildExecutionGraph` and validated for hazards on
 * first activation. Subsequent calls return the cached instance.
 *
 * Throws if the mode id is not registered in `reg`.
 */
export function getOrBuildGraphForMode(reg: Registry, modeId: string): ExecutionGraph {
  let perReg = graphCacheByRegistry.get(reg);
  if (!perReg) {
    perReg = new Map();
    graphCacheByRegistry.set(reg, perReg);
  }
  const cached = perReg.get(modeId);
  if (cached) return cached;
  const mode = reg.getMode(modeId);
  if (!mode) throw new Error(`getOrBuildGraphForMode: mode '${modeId}' is not registered.`);
  const graph = buildExecutionGraph({
    id: modeId,
    nodes: mode.systems,
    registry: reg,
  });
  perReg.set(modeId, graph);
  return graph;
}

export function createModeRegistry(): ModeRegistry {
  const modes = new Map<string, Mode>();

  function passes(m: Mode, filter: ModeListFilter): boolean {
    if (filter.tags && filter.tags.length > 0) {
      if (!m.tags) return false;
      for (const t of filter.tags) {
        if (!m.tags.includes(t)) return false;
      }
    }
    if (filter.search && filter.search.length > 0) {
      const s = filter.search.toLowerCase();
      const hit = m.id.toLowerCase().includes(s) || m.label.toLowerCase().includes(s);
      if (!hit) return false;
    }
    return true;
  }

  return {
    register(mode: Mode): void {
      if (modes.has(mode.id)) {
        throw new Error(`ModeRegistry: mode '${mode.id}' is already registered.`);
      }
      modes.set(mode.id, mode);
    },
    get(id: string): Mode | undefined {
      return modes.get(id);
    },
    has(id: string): boolean {
      return modes.has(id);
    },
    list(filter?: ModeListFilter): Mode[] {
      const all = Array.from(modes.values());
      if (!filter) return all;
      return all.filter((m) => passes(m, filter));
    },
  };
}
