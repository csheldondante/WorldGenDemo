import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { createBuffer } from "../../src/runtime/buffer";
import type { SystemDescriptor } from "../../src/runtime/system";

describe("Hazard enforcement (V0 doc requirement)", () => {
  it("two writers to the same buffer without ordering throws", () => {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer({ id: "shared", description: "shared", initial: 0 }));
    const a: SystemDescriptor = {
      id: "a",
      description: "writer a",
      buffers: [{ id: "shared", access: "write" }],
      execute: () => {},
    };
    const b: SystemDescriptor = {
      id: "b",
      description: "writer b",
      buffers: [{ id: "shared", access: "write" }],
      execute: () => {},
    };
    reg.registerSystem(a);
    reg.registerSystem(b);
    expect(() =>
      buildExecutionGraph({ id: "hazard", nodes: ["a", "b"], registry: reg }),
    ).toThrow(/hazard.*shared/i);
  });

  it("missing buffer dependency throws clearly", () => {
    const reg = createRegistry();
    const a: SystemDescriptor = {
      id: "a",
      description: "needs ghost",
      buffers: [{ id: "ghost", access: "read" }],
      execute: () => {},
    };
    reg.registerSystem(a);
    expect(() =>
      buildExecutionGraph({ id: "g", nodes: ["a"], registry: reg }),
    ).toThrow(/ghost/);
  });

  it("system declared in graph but not registered throws", () => {
    const reg = createRegistry();
    expect(() =>
      buildExecutionGraph({ id: "g", nodes: ["nonexistent"], registry: reg }),
    ).toThrow(/nonexistent/);
  });
});
