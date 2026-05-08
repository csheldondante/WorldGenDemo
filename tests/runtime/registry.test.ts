import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer } from "../../src/runtime/buffer";
import type { SystemDescriptor } from "../../src/runtime/system";

const dummySystem = (id: string): SystemDescriptor => ({
  id,
  description: `dummy ${id}`,
  buffers: [],
  execute: () => {},
});

describe("Registry", () => {
  it("registers and retrieves buffers", () => {
    const reg = createRegistry();
    const b = createBuffer({ id: "x", description: "x", initial: 0 });
    reg.registerBuffer(b);
    expect(reg.getBuffer<number>("x")).toBe(b);
  });

  it("rejects duplicate buffer ids", () => {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer({ id: "x", description: "x", initial: 0 }));
    expect(() => reg.registerBuffer(createBuffer({ id: "x", description: "x", initial: 1 }))).toThrow(/duplicate buffer/);
  });

  it("rejects duplicate system ids", () => {
    const reg = createRegistry();
    reg.registerSystem(dummySystem("a"));
    expect(() => reg.registerSystem(dummySystem("a"))).toThrow(/duplicate system/);
  });

  it("getBuffer throws clearly on unknown id", () => {
    const reg = createRegistry();
    expect(() => reg.getBuffer("missing")).toThrow(/missing/);
  });

  it("getSystem throws clearly on unknown id", () => {
    const reg = createRegistry();
    expect(() => reg.getSystem("missing")).toThrow(/missing/);
  });

  it("listBuffers / listSystems return registration order", () => {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer({ id: "first", description: "1", initial: 0 }));
    reg.registerBuffer(createBuffer({ id: "second", description: "2", initial: 0 }));
    reg.registerSystem(dummySystem("alpha"));
    reg.registerSystem(dummySystem("beta"));
    expect(reg.listBuffers().map((b) => b.id)).toEqual(["first", "second"]);
    expect(reg.listSystems().map((s) => s.id)).toEqual(["alpha", "beta"]);
  });
});
