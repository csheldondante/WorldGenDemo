import { describe, it, expect } from "vitest";
import { Dag, DagCycleError } from "../../src/lib/dag";

describe("Dag", () => {
  describe("addNode / hasNode", () => {
    it("adds and reports membership", () => {
      const d = new Dag<string>();
      d.addNode("a");
      expect(d.hasNode("a")).toBe(true);
      expect(d.hasNode("b")).toBe(false);
    });

    it("addNode is idempotent", () => {
      const d = new Dag<string>();
      d.addNode("a");
      d.addNode("a");
      expect(d.nodes()).toEqual(["a"]);
    });
  });

  describe("addEdge", () => {
    it("auto-adds endpoints if missing", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      expect(d.hasNode("a")).toBe(true);
      expect(d.hasNode("b")).toBe(true);
    });

    it("is idempotent on (from, to) pairs", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b", "first");
      d.addEdge("a", "b", "second"); // re-adding does not multiply edges
      expect(d.edges().length).toBe(1);
    });

    it("hasEdge reflects insertion", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      expect(d.hasEdge("a", "b")).toBe(true);
      expect(d.hasEdge("b", "a")).toBe(false);
    });

    it("rejects self-loops", () => {
      const d = new Dag<string>();
      expect(() => d.addEdge("a", "a")).toThrow();
    });
  });

  describe("topoSort", () => {
    it("sorts a small DAG in dependency order", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      d.addEdge("b", "c");
      d.addEdge("a", "c");
      const order = d.topoSort();
      expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
      expect(order.indexOf("b")).toBeLessThan(order.indexOf("c"));
    });

    it("includes orphan nodes (no edges) in the order", () => {
      const d = new Dag<string>();
      d.addNode("orphan");
      d.addEdge("a", "b");
      const order = d.topoSort();
      expect(order).toContain("orphan");
      expect(order).toContain("a");
      expect(order).toContain("b");
      expect(order.length).toBe(3);
    });

    it("throws DagCycleError on a 2-cycle, naming the offending nodes", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      d.addEdge("b", "a");
      try {
        d.topoSort();
        expect.fail("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(DagCycleError);
        expect((e as DagCycleError).message).toMatch(/a/);
        expect((e as DagCycleError).message).toMatch(/b/);
      }
    });

    it("throws DagCycleError on a 3-cycle", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      d.addEdge("b", "c");
      d.addEdge("c", "a");
      expect(() => d.topoSort()).toThrow(DagCycleError);
    });
  });

  describe("findCycles", () => {
    it("returns [] for an acyclic graph", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      d.addEdge("b", "c");
      expect(d.findCycles()).toEqual([]);
    });

    it("finds a 3-cycle", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      d.addEdge("b", "c");
      d.addEdge("c", "a");
      const cycles = d.findCycles();
      expect(cycles.length).toBeGreaterThan(0);
      const flat = new Set(cycles.flat());
      expect(flat.has("a")).toBe(true);
      expect(flat.has("b")).toBe(true);
      expect(flat.has("c")).toBe(true);
    });
  });

  describe("ancestors / descendants", () => {
    it("ancestors returns transitive predecessors", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      d.addEdge("b", "c");
      d.addEdge("d", "c");
      expect(Array.from(d.ancestors("c")).sort()).toEqual(["a", "b", "d"]);
    });

    it("descendants returns transitive successors", () => {
      const d = new Dag<string>();
      d.addEdge("a", "b");
      d.addEdge("b", "c");
      d.addEdge("b", "d");
      expect(Array.from(d.descendants("a")).sort()).toEqual(["b", "c", "d"]);
    });
  });
});
