import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { getOrBuildGraphForMode } from "../../src/runtime/mode";
import type { SystemDescriptor } from "../../src/runtime/system";

/**
 * Phase 1b: the loop drives the scheduler from `activeMode`, not the legacy
 * pre-registered `activeGraph`. The execution graph is DERIVED on demand
 * from `mode.systems` via `buildExecutionGraph`, then cached per mode-id
 * so subsequent ticks don't pay topological-sort cost.
 *
 * These tests use synthetic systems to keep the runtime layer
 * feature-agnostic (per `src/runtime/CLAUDE.md`). The integration test
 * that mode-derived graphs equal the pre-registered ones for the real
 * core graphs lives in `tests/migration/coreGraphs.test.ts`.
 */

function syntheticSystem(id: string, runsAfter: string[] = []): SystemDescriptor {
  return {
    id,
    description: `synthetic ${id}`,
    buffers: [],
    runsAfter,
    execute: () => {},
  };
}

describe("getOrBuildGraphForMode", () => {
  it("builds an ExecutionGraph from mode.systems on first call", () => {
    const reg = createRegistry();
    reg.registerSystem(syntheticSystem("a"));
    reg.registerSystem(syntheticSystem("b", ["a"]));
    reg.registerMode({ id: "test", label: "Test", systems: ["a", "b"] });

    const g = getOrBuildGraphForMode(reg, "test");
    expect(g.id).toBe("test");
    expect(g.nodes).toEqual(["a", "b"]);
    expect(g.order).toEqual(["a", "b"]);
  });

  it("caches the graph — second call returns the SAME instance", () => {
    const reg = createRegistry();
    reg.registerSystem(syntheticSystem("a"));
    reg.registerMode({ id: "test", label: "Test", systems: ["a"] });

    const g1 = getOrBuildGraphForMode(reg, "test");
    const g2 = getOrBuildGraphForMode(reg, "test");
    expect(g1).toBe(g2);
  });

  it("returns distinct graphs for distinct modes", () => {
    const reg = createRegistry();
    reg.registerSystem(syntheticSystem("a"));
    reg.registerSystem(syntheticSystem("b"));
    reg.registerMode({ id: "m1", label: "M1", systems: ["a"] });
    reg.registerMode({ id: "m2", label: "M2", systems: ["b"] });

    expect(getOrBuildGraphForMode(reg, "m1")).not.toBe(
      getOrBuildGraphForMode(reg, "m2"),
    );
  });

  it("throws on unknown mode id", () => {
    const reg = createRegistry();
    expect(() => getOrBuildGraphForMode(reg, "nope")).toThrow(/mode/i);
  });
});
