import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { exportGraphSnapshot } from "../../src/runtime/mode";
import type { SystemDescriptor } from "../../src/runtime/system";

/**
 * Phase 1c: the inspector / library-viewer / drag-and-drop editor
 * needs a snapshot of the active execution graph as plain JSON. This
 * snapshot is a ONE-WAY EXPORT (= viewing only); mutations to the
 * runtime configuration go back through `mode.systems`.
 *
 * The snapshot must include enough to reconstruct the graph
 * visually: each node with its buffer reads/writes (= for showing
 * data flow), and the topological order (= for showing tick
 * sequence).
 */

function syntheticSystem(
  id: string,
  reads: string[] = [],
  writes: string[] = [],
  runsAfter: string[] = [],
): SystemDescriptor {
  return {
    id,
    description: `synthetic ${id}`,
    buffers: [
      ...reads.map((b) => ({ id: b, access: "read" as const })),
      ...writes.map((b) => ({ id: b, access: "write" as const })),
    ],
    runsAfter,
    execute: () => {},
  };
}

describe("exportGraphSnapshot", () => {
  function setupTwoNodeGraph() {
    const reg = createRegistry();
    reg.registerBuffer({ id: "buf-a", description: "", version: 0, data: {} } as never);
    reg.registerBuffer({ id: "buf-b", description: "", version: 0, data: {} } as never);
    reg.registerSystem(syntheticSystem("sys-a", [], ["buf-a"]));
    reg.registerSystem(syntheticSystem("sys-b", ["buf-a"], ["buf-b"], ["sys-a"]));
    const g = buildExecutionGraph({ id: "test", nodes: ["sys-a", "sys-b"], registry: reg });
    return { reg, g };
  }

  it("includes every node with its declared buffer reads and writes", () => {
    const { reg, g } = setupTwoNodeGraph();
    const snapshot = exportGraphSnapshot(g, reg);
    expect(snapshot.nodes.map((n) => n.id).sort()).toEqual(["sys-a", "sys-b"]);
    const a = snapshot.nodes.find((n) => n.id === "sys-a")!;
    expect(a.reads).toEqual([]);
    expect(a.writes).toEqual(["buf-a"]);
    const b = snapshot.nodes.find((n) => n.id === "sys-b")!;
    expect(b.reads).toEqual(["buf-a"]);
    expect(b.writes).toEqual(["buf-b"]);
  });

  it("includes the topological order from the graph", () => {
    const { reg, g } = setupTwoNodeGraph();
    const snapshot = exportGraphSnapshot(g, reg);
    expect(snapshot.topoOrder).toEqual(g.order);
  });

  it("includes all edges from the graph (with reason labels)", () => {
    const { reg, g } = setupTwoNodeGraph();
    const snapshot = exportGraphSnapshot(g, reg);
    expect(snapshot.edges.length).toBe(g.edges.length);
    for (const e of g.edges) {
      const match = snapshot.edges.find((s) => s.from === e.from && s.to === e.to);
      expect(match).toBeDefined();
      expect(match!.reason).toBe(e.reason);
    }
  });

  it("produces a JSON-serializable result", () => {
    const { reg, g } = setupTwoNodeGraph();
    const snapshot = exportGraphSnapshot(g, reg);
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    const roundTrip = JSON.parse(JSON.stringify(snapshot));
    expect(roundTrip).toEqual(snapshot);
  });

  it("classifies readwrite buffer access as both reads AND writes", () => {
    const reg = createRegistry();
    reg.registerBuffer({ id: "x", description: "", version: 0, data: {} } as never);
    reg.registerSystem({
      id: "rw",
      description: "readwrite test",
      buffers: [{ id: "x", access: "readwrite" }],
      execute: () => {},
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["rw"], registry: reg });
    const snapshot = exportGraphSnapshot(g, reg);
    expect(snapshot.nodes[0].reads).toEqual(["x"]);
    expect(snapshot.nodes[0].writes).toEqual(["x"]);
  });
});
