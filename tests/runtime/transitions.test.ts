import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";

/**
 * Phase 3 — Transitions with shared buffers.
 *
 * A Transition is a (from, to, systems, isComplete) tuple registered
 * separately from Modes. While a transition is active, its system
 * list runs each tick; when `isComplete(reg)` returns true the target
 * mode activates and the transition's systems stop.
 *
 * The "shared buffers" half is automatic: any buffer referenced by
 * BOTH the source mode's systems and the target mode's systems
 * persists across the swap by virtue of being in both buffer scopes.
 * A transition's own systems can additionally write into intermediate
 * buffers (= e.g., a `ProjectedCharacterPosition` for a 3D→2D hot
 * swap) that BOTH endpoints reference.
 *
 * Phase 3a (this batch) lands the type + registry + lookup. The
 * runtime activation logic (= scheduler executes transition graph
 * until isComplete, then swaps activeMode) is Phase 3b.
 */

import type { Transition } from "../../src/runtime/transition";

describe("TransitionRegistry", () => {
  it("registers and retrieves a transition by id", () => {
    const reg = createRegistry();
    const t: Transition = {
      id: "RunningToLibraryViewer",
      from: "Running",
      to: "LibraryViewer",
      systems: [],
      isComplete: () => true,
    };
    reg.registerTransition(t);
    expect(reg.getTransition("RunningToLibraryViewer")).toBe(t);
    expect(reg.hasTransition("RunningToLibraryViewer")).toBe(true);
  });

  it("rejects duplicate transition ids", () => {
    const reg = createRegistry();
    reg.registerTransition({ id: "x", from: "A", to: "B", systems: [], isComplete: () => true });
    expect(() =>
      reg.registerTransition({ id: "x", from: "A", to: "C", systems: [], isComplete: () => true }),
    ).toThrow(/already registered/);
  });

  it("lists transitions, optionally filtering by from/to", () => {
    const reg = createRegistry();
    reg.registerTransition({ id: "t1", from: "A", to: "B", systems: [], isComplete: () => true });
    reg.registerTransition({ id: "t2", from: "A", to: "C", systems: [], isComplete: () => true });
    reg.registerTransition({ id: "t3", from: "B", to: "C", systems: [], isComplete: () => true });
    expect(reg.listTransitions().map((t) => t.id).sort()).toEqual(["t1", "t2", "t3"]);
    expect(reg.listTransitions({ from: "A" }).map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(reg.listTransitions({ to: "C" }).map((t) => t.id).sort()).toEqual(["t2", "t3"]);
    expect(reg.listTransitions({ from: "A", to: "B" }).map((t) => t.id)).toEqual(["t1"]);
  });

  it("isComplete is invoked with the registry — predicate can read buffers", () => {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer({ id: "progress", description: "", initial: { pct: 0 } }));
    const t: Transition = {
      id: "wait-for-load",
      from: "Loading",
      to: "Running",
      systems: [],
      isComplete: (r) => readBuffer(r.getBuffer<{ pct: number }>("progress")).pct >= 1.0,
    };
    reg.registerTransition(t);
    // Initially incomplete.
    expect(t.isComplete(reg)).toBe(false);
    // Bump progress.
    writeBuffer(reg.getBuffer<{ pct: number }>("progress"), (d) => { d.pct = 1.0; });
    expect(t.isComplete(reg)).toBe(true);
  });

  it("getTransition returns undefined for unknown ids", () => {
    const reg = createRegistry();
    expect(reg.getTransition("nope")).toBeUndefined();
    expect(reg.hasTransition("nope")).toBe(false);
  });
});
