import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { getOrBuildGraphForMode } from "../../src/runtime/mode";
import { registerCoreBuffers } from "../../src/buffers";
import { registerCoreSystems } from "../../src/systems";
import { buildAndRegisterCoreGraphs } from "../../src/app/graphs";
import { registerInfrastructureSystems } from "../../src/runtime/infrastructureSystems";

/**
 * Regression test for the silent-validation-error bug: previously hudSystem
 * read `timing` while loadSceneSystem wrote it, with no ordering between
 * them in the Loading graph. The runtime threw at startup but the throw
 * was caught only by the global window error handler, leaving a black
 * screen with no visible error. This test catches such hazards before
 * they reach the runtime.
 */
describe("Core graphs validate cleanly with all real buffers and systems", () => {
  it("registers all buffers, systems, and graphs without throwing", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg);
    expect(() => buildAndRegisterCoreGraphs(reg)).not.toThrow();
  });

  it("each registered graph topo-sorts to a valid order", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg);
    const { loading, running, rebuilding, builder } = buildAndRegisterCoreGraphs(reg);
    for (const g of [loading, running, rebuilding, builder]) {
      expect(g.order.length).toBe(g.nodes.length);
      // Ordering: every edge respected
      const pos = new Map(g.order.map((id, i) => [id, i] as const));
      for (const edge of g.edges) {
        expect(pos.get(edge.from)!).toBeLessThan(pos.get(edge.to)!);
      }
    }
  });

  /**
   * Phase 1 of the modes-and-modules refactor: every core graph is also
   * registered as a Mode whose `systems` field matches the graph's
   * `nodes`. The graph remains derivable from the mode (= via
   * buildExecutionGraph), so save/load can persist mode ids and rebuild
   * the runtime configuration on restore. See `docs/modes-and-modules.md`.
   */
  it("registers each core graph as a Mode with matching system list", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg);
    const { loading, running, rebuilding, builder } = buildAndRegisterCoreGraphs(reg);

    for (const g of [loading, running, rebuilding, builder]) {
      expect(reg.hasMode(g.id)).toBe(true);
      const mode = reg.getMode(g.id)!;
      expect(mode.id).toBe(g.id);
      expect(mode.systems).toEqual(g.nodes);
    }

    // Modes are listable and tag-filterable.
    const coreModes = reg.listModes({ tags: ["core"] });
    expect(coreModes.map((m) => m.id).sort()).toEqual(["Loading", "Rebuilding", "Running"]);
    const editorModes = reg.listModes({ tags: ["editor"] });
    expect(editorModes.map((m) => m.id)).toEqual(["Builder"]);
  });

  /**
   * Phase 1b: the loop derives the active graph from `mode.systems`
   * via `getOrBuildGraphForMode` instead of looking up a pre-registered
   * graph. Behavior must be preserved — for every core mode, the
   * derived graph must have the same nodes (= system membership) as
   * the pre-registered graph. Ordering may differ since `buildExecutionGraph`
   * is the same code path, but nodes must match.
   */
  it("mode-derived graph for each core mode equals the pre-registered graph", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg);
    const { loading, running, rebuilding, builder } = buildAndRegisterCoreGraphs(reg);
    for (const g of [loading, running, rebuilding, builder]) {
      const derived = getOrBuildGraphForMode(reg, g.id);
      expect(new Set(derived.nodes)).toEqual(new Set(g.nodes));
      // Ordering: same hazard rules → same topo ordering (deterministic).
      expect(derived.order).toEqual(g.order);
    }
  });
});
