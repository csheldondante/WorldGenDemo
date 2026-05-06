import { describe, it, expect } from "vitest";
import { mulberry32, hashString, subSeed, rngForKey } from "../src/core/rng";

describe("mulberry32", () => {
  it("is deterministic for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it("differs across seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 50; i++) if (a() === b()) same++;
    expect(same).toBeLessThan(5);
  });

  it("produces values in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("hashString", () => {
  it("differs across distinct strings", () => {
    expect(hashString("foo")).not.toBe(hashString("bar"));
    expect(hashString("a")).not.toBe(hashString("b"));
  });

  it("is stable across calls", () => {
    expect(hashString("hello world")).toBe(hashString("hello world"));
  });
});

describe("subSeed / rngForKey", () => {
  it("derives different streams from the same parent for different keys", () => {
    const a = rngForKey(1234, "trees");
    const b = rngForKey(1234, "rocks");
    let collisions = 0;
    for (let i = 0; i < 50; i++) if (a() === b()) collisions++;
    expect(collisions).toBeLessThan(5);
  });

  it("is reproducible for the same parent + key", () => {
    const a = rngForKey(99, "shanty");
    const b = rngForKey(99, "shanty");
    expect(a()).toBe(b());
    expect(a()).toBe(b());
  });

  it("subSeed returns a uint32", () => {
    const s = subSeed(42, "x");
    expect(s).toBe(s >>> 0);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});
