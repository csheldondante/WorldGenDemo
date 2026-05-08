import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { registerCoreBuffers } from "../../src/buffers";
import { registerCoreSystems } from "../../src/systems";
import { buildAndRegisterCoreGraphs } from "../../src/app/graphs";

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
    expect(() => buildAndRegisterCoreGraphs(reg)).not.toThrow();
  });

  it("each registered graph topo-sorts to a valid order", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
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
});
