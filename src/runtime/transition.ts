/**
 * Transitions — Phase 3 of the modes-and-modules refactor (see
 * `docs/modes-and-modules.md`).
 *
 * A Transition runs between modes — when the runtime is asked to
 * switch from mode `from` to mode `to`, an optional matching
 * Transition runs its `systems` each tick until `isComplete(reg)`
 * returns true, at which point the target mode activates.
 *
 * Transitions enable hot-swap between modes with disparate data
 * representations. The classic example is 3D ↔ 2D-top-down: both
 * modes share a `ProjectedCharacterPosition` buffer; the transition
 * writes into it from the source mode's representation and the target
 * mode reads from it as initial state. No loading screen needed.
 *
 * Phase 3a (this commit) provides the type + registry + lookup. The
 * scheduler-side activation logic (= when the SM requests a mode
 * switch, look up a matching transition and run its graph until
 * complete) is Phase 3b.
 */

import type { Registry } from "./registry";
import type { SystemId } from "./system";

export interface Transition {
  /** Unique transition id (= "RunningToLibraryViewer",
   *  "ThreeDToTopDown", "SceneLoader"). */
  id: string;
  /** Source mode id this transition starts from. */
  from: string;
  /** Destination mode id this transition completes into. */
  to: string;
  /** System ids that run each tick while the transition is active.
   *  Like a Mode, the ExecutionGraph is DERIVED from this list +
   *  declared dependencies at activation time. */
  systems: SystemId[];
  /** Predicate evaluated each tick. When it returns true, the target
   *  mode activates and the transition stops. */
  isComplete: (reg: Registry) => boolean;
}

export interface TransitionListFilter {
  /** Filter by source mode id. */
  from?: string;
  /** Filter by destination mode id. */
  to?: string;
}

export interface TransitionRegistry {
  register(t: Transition): void;
  get(id: string): Transition | undefined;
  has(id: string): boolean;
  list(filter?: TransitionListFilter): Transition[];
}

export function createTransitionRegistry(): TransitionRegistry {
  const transitions = new Map<string, Transition>();
  const order: string[] = [];
  return {
    register(t: Transition): void {
      if (transitions.has(t.id)) {
        throw new Error(`TransitionRegistry: transition '${t.id}' is already registered.`);
      }
      transitions.set(t.id, t);
      order.push(t.id);
    },
    get(id) { return transitions.get(id); },
    has(id) { return transitions.has(id); },
    list(filter?: TransitionListFilter): Transition[] {
      let all = order.map((id) => transitions.get(id)!);
      if (filter?.from !== undefined) all = all.filter((t) => t.from === filter.from);
      if (filter?.to !== undefined) all = all.filter((t) => t.to === filter.to);
      return all;
    },
  };
}
