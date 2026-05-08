import { describe, it, expect } from "vitest";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer } from "../../src/runtime/buffer";
import type { SystemDescriptor } from "../../src/runtime/system";

function sys(id: string, opts: Partial<SystemDescriptor> = {}): SystemDescriptor {
  return {
    id,
    description: opts.description ?? `system ${id}`,
    buffers: opts.buffers ?? [],
    runsAfter: opts.runsAfter,
    runsBefore: opts.runsBefore,
    execute: opts.execute ?? (() => {}),
  };
}

function basicReg(systems: SystemDescriptor[], buffers: string[] = []) {
  const reg = createRegistry();
  for (const id of buffers) {
    reg.registerBuffer(createBuffer({ id, description: id, initial: 0 }));
  }
  for (const s of systems) reg.registerSystem(s);
  return reg;
}

describe("buildExecutionGraph", () => {
  it("topo-sorts a simple chain", () => {
    const reg = basicReg([
      sys("a"),
      sys("b", { runsAfter: ["a"] }),
      sys("c", { runsAfter: ["b"] }),
    ]);
    const g = buildExecutionGraph({ id: "test", nodes: ["a", "b", "c"], registry: reg });
    expect(g.order).toEqual(["a", "b", "c"]);
    expect(g.edges.length).toBe(2);
  });

  it("respects runsBefore", () => {
    const reg = basicReg([
      sys("a", { runsBefore: ["b"] }),
      sys("b"),
    ]);
    const g = buildExecutionGraph({ id: "test", nodes: ["a", "b"], registry: reg });
    expect(g.order).toEqual(["a", "b"]);
  });

  it("throws on a cycle", () => {
    const reg = basicReg([
      sys("a", { runsAfter: ["b"] }),
      sys("b", { runsAfter: ["a"] }),
    ]);
    expect(() => buildExecutionGraph({ id: "cycle", nodes: ["a", "b"], registry: reg })).toThrow();
  });

  it("throws when a system in nodes is unregistered", () => {
    const reg = basicReg([sys("a")]);
    expect(() => buildExecutionGraph({ id: "g", nodes: ["a", "ghost"], registry: reg })).toThrow(/ghost/);
  });

  it("throws when a system declares a buffer that is not registered", () => {
    const reg = basicReg([
      sys("a", { buffers: [{ id: "missing", access: "read" }] }),
    ]);
    expect(() =>
      buildExecutionGraph({ id: "g", nodes: ["a"], registry: reg })
    ).toThrow(/missing/);
  });

  it("detects write-write hazards (two writers without ordering)", () => {
    const reg = basicReg(
      [
        sys("w1", { buffers: [{ id: "buf", access: "write" }] }),
        sys("w2", { buffers: [{ id: "buf", access: "write" }] }),
      ],
      ["buf"],
    );
    expect(() =>
      buildExecutionGraph({ id: "hazard", nodes: ["w1", "w2"], registry: reg })
    ).toThrow(/hazard/i);
  });

  it("allows two writers when ordered with runsAfter", () => {
    const reg = basicReg(
      [
        sys("w1", { buffers: [{ id: "buf", access: "write" }] }),
        sys("w2", { buffers: [{ id: "buf", access: "write" }], runsAfter: ["w1"] }),
      ],
      ["buf"],
    );
    const g = buildExecutionGraph({ id: "ok", nodes: ["w1", "w2"], registry: reg });
    expect(g.order).toEqual(["w1", "w2"]);
  });

  it("detects read-write hazards (reader and writer without ordering)", () => {
    const reg = basicReg(
      [
        sys("r", { buffers: [{ id: "buf", access: "read" }] }),
        sys("w", { buffers: [{ id: "buf", access: "write" }] }),
      ],
      ["buf"],
    );
    expect(() =>
      buildExecutionGraph({ id: "rw", nodes: ["r", "w"], registry: reg })
    ).toThrow(/hazard/i);
  });

  it("multiple readers without writer ordering is fine", () => {
    const reg = basicReg(
      [
        sys("r1", { buffers: [{ id: "buf", access: "read" }] }),
        sys("r2", { buffers: [{ id: "buf", access: "read" }] }),
      ],
      ["buf"],
    );
    const g = buildExecutionGraph({ id: "rr", nodes: ["r1", "r2"], registry: reg });
    expect(g.order).toContain("r1");
    expect(g.order).toContain("r2");
  });

  it("includes useful detail in hazard error message", () => {
    const reg = basicReg(
      [
        sys("w1", { buffers: [{ id: "buf", access: "write" }] }),
        sys("w2", { buffers: [{ id: "buf", access: "write" }] }),
      ],
      ["buf"],
    );
    try {
      buildExecutionGraph({ id: "h", nodes: ["w1", "w2"], registry: reg });
      expect.fail("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/w1/);
      expect(msg).toMatch(/w2/);
      expect(msg).toMatch(/buf/);
    }
  });
});
