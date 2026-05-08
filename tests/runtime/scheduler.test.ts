import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import type { SystemDescriptor } from "../../src/runtime/system";

describe("executeGraph", () => {
  it("runs systems in declared order", () => {
    const reg = createRegistry();
    const log = createBuffer({ id: "log", description: "ordering log", initial: [] as string[] });
    reg.registerBuffer(log);

    const sys = (id: string, runsAfter?: string[]): SystemDescriptor => ({
      id,
      description: `step ${id}`,
      buffers: [{ id: "log", access: "write" }],
      runsAfter,
      execute: ({ buffer }) => {
        const b = buffer<string[]>("log");
        writeBuffer(b, (d) => { d.push(id); });
      },
    });
    reg.registerSystem(sys("a"));
    reg.registerSystem(sys("b", ["a"]));
    reg.registerSystem(sys("c", ["b"]));

    const g = buildExecutionGraph({ id: "g", nodes: ["a", "b", "c"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    expect(readBuffer(log)).toEqual(["a", "b", "c"]);
  });

  it("system N+1 sees mutations from system N (same tick)", () => {
    const reg = createRegistry();
    const counter = createBuffer({ id: "counter", description: "counter", initial: { n: 0 } });
    reg.registerBuffer(counter);

    reg.registerSystem({
      id: "increment",
      description: "increment",
      buffers: [{ id: "counter", access: "write" }],
      execute: ({ buffer }) => {
        const c = buffer<{ n: number }>("counter");
        writeBuffer(c, (d) => { d.n += 1; });
      },
    });
    reg.registerSystem({
      id: "double",
      description: "double",
      buffers: [{ id: "counter", access: "write" }],
      runsAfter: ["increment"],
      execute: ({ buffer }) => {
        const c = buffer<{ n: number }>("counter");
        writeBuffer(c, (d) => { d.n *= 2; });
      },
    });

    const g = buildExecutionGraph({ id: "g", nodes: ["increment", "double"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(counter).n).toBe(2); // (0 + 1) * 2
  });

  it("ctx.dt is forwarded to systems", () => {
    const reg = createRegistry();
    const log = createBuffer({ id: "log", description: "log", initial: { dt: 0 } });
    reg.registerBuffer(log);
    reg.registerSystem({
      id: "s",
      description: "s",
      buffers: [{ id: "log", access: "write" }],
      execute: ({ dt, buffer }) => {
        const l = buffer<{ dt: number }>("log");
        writeBuffer(l, (d) => { d.dt = dt; });
      },
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["s"], registry: reg });
    executeGraph(g, reg, { dt: 0.016, now: 100 });
    expect(readBuffer(log).dt).toBeCloseTo(0.016);
  });
});
