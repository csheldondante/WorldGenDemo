import { describe, it, expect } from "vitest";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";

describe("Buffer", () => {
  it("starts at version 0", () => {
    const b = createBuffer({ id: "test", description: "for tests", initial: { x: 1 } });
    expect(b.version).toBe(0);
    expect(readBuffer(b).x).toBe(1);
  });

  it("write bumps version once per call", () => {
    const b = createBuffer({ id: "test", description: "for tests", initial: { x: 0 } });
    writeBuffer(b, (d) => { d.x = 1; });
    expect(b.version).toBe(1);
    writeBuffer(b, (d) => { d.x = 2; });
    expect(b.version).toBe(2);
    expect(readBuffer(b).x).toBe(2);
  });

  it("read does not bump version", () => {
    const b = createBuffer({ id: "test", description: "for tests", initial: { x: 0 } });
    readBuffer(b);
    readBuffer(b);
    readBuffer(b);
    expect(b.version).toBe(0);
  });

  it("write returning a new value replaces data", () => {
    const b = createBuffer({ id: "test", description: "for tests", initial: { x: 0 } });
    writeBuffer(b, () => ({ x: 99 }));
    expect(readBuffer(b)).toEqual({ x: 99 });
    expect(b.version).toBe(1);
  });
});
