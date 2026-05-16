/**
 * Unit tests for the canonical buffer snapshot serializer.
 *
 * Covers every primitive/structural shape the snapshot walker encounters
 * across the WorldGenDemo buffer set: primitives, plain objects, plain
 * arrays, Maps (sorted), Sets (sorted), typed arrays, nested combinations
 * mirroring real buffer schemas (`Map<EntityId, { position: [x,y,z], ... }>`),
 * plus edge cases (non-finite numbers, class instances).
 */
import { describe, it, expect } from "vitest";
import { snapshotBufferData, restoreBufferData, type SnapshotValue } from "../../../src/lib/testing/bufferSnapshot";

describe("snapshotBufferData — primitives", () => {
  it("passes through booleans, strings, finite numbers, null, undefined→null", () => {
    expect(snapshotBufferData(true)).toBe(true);
    expect(snapshotBufferData("hello")).toBe("hello");
    expect(snapshotBufferData(3.14)).toBe(3.14);
    expect(snapshotBufferData(0)).toBe(0);
    expect(snapshotBufferData(null)).toBe(null);
    expect(snapshotBufferData(undefined)).toBe(null);
  });

  it("refuses non-finite numbers (NaN, ±Infinity)", () => {
    expect(() => snapshotBufferData(NaN)).toThrowError(/non-finite/);
    expect(() => snapshotBufferData(Infinity)).toThrowError(/non-finite/);
    expect(() => snapshotBufferData(-Infinity)).toThrowError(/non-finite/);
  });

  it("refuses bigint, function, symbol", () => {
    expect(() => snapshotBufferData(1n)).toThrowError(/unsupported type/);
    expect(() => snapshotBufferData(() => 0)).toThrowError(/unsupported type/);
    expect(() => snapshotBufferData(Symbol("x"))).toThrowError(/unsupported type/);
  });
});

describe("snapshotBufferData — plain objects + arrays", () => {
  it("sorts plain-object keys for canonical output", () => {
    const enc = snapshotBufferData({ z: 1, a: 2, m: 3 });
    expect(Object.keys(enc as Record<string, unknown>)).toEqual(["a", "m", "z"]);
  });

  it("preserves array order (index = identity)", () => {
    expect(snapshotBufferData([3, 1, 2])).toEqual([3, 1, 2]);
    expect(snapshotBufferData(["c", "a", "b"])).toEqual(["c", "a", "b"]);
  });

  it("recurses into nested arrays + objects, normalizing keys at every level", () => {
    const data = {
      outer: [{ b: 1, a: 0 }, { b: 3, a: 2 }],
      meta: { c: { z: "x", a: "y" } },
    };
    const enc = snapshotBufferData(data) as Record<string, SnapshotValue>;
    expect(Object.keys(enc)).toEqual(["meta", "outer"]);
    expect(Object.keys((enc.outer as Record<string, SnapshotValue>[])[0])).toEqual(["a", "b"]);
    expect(Object.keys((enc.meta as Record<string, SnapshotValue>).c as Record<string, SnapshotValue>)).toEqual(["a", "z"]);
  });
});

describe("snapshotBufferData — Map (sorted entries)", () => {
  it("encodes a Map<number, X> as a sorted-by-key object with the MAP_TAG", () => {
    const m = new Map<number, { v: number }>();
    m.set(3, { v: 30 });
    m.set(1, { v: 10 });
    m.set(2, { v: 20 });
    const enc = snapshotBufferData(m) as Record<string, SnapshotValue>;
    expect(enc.__map__).toBe(true);
    const keys = Object.keys(enc).filter((k) => k !== "__map__");
    expect(keys).toEqual(["1", "2", "3"]);
  });

  it("supports string keys (encoded as-is, sorted lexicographically)", () => {
    const m = new Map([
      ["zebra", 1],
      ["apple", 2],
    ]);
    const enc = snapshotBufferData(m) as Record<string, SnapshotValue>;
    const keys = Object.keys(enc).filter((k) => k !== "__map__");
    expect(keys).toEqual(["apple", "zebra"]);
  });

  it("roundtrips via restoreBufferData with integer keys recovered as numbers", () => {
    const m = new Map<number, [number, number, number]>();
    m.set(1, [1, 2, 3]);
    m.set(42, [4, 5, 6]);
    const enc = snapshotBufferData(m);
    const rec = restoreBufferData(enc) as Map<unknown, unknown>;
    expect(rec instanceof Map).toBe(true);
    expect(rec.size).toBe(2);
    expect(rec.get(1)).toEqual([1, 2, 3]);
    expect(rec.get(42)).toEqual([4, 5, 6]);
  });
});

describe("snapshotBufferData — Set (sorted)", () => {
  it("encodes a Set<string> as sorted array with SET_TAG", () => {
    const s = new Set(["KeyW", "KeyA", "Space"]);
    const enc = snapshotBufferData(s) as { __set__: true; values: string[] };
    expect(enc.__set__).toBe(true);
    expect(enc.values).toEqual(["KeyA", "KeyW", "Space"]);
  });

  it("encodes a Set<number> numerically sorted", () => {
    const s = new Set([3, 1, 2]);
    const enc = snapshotBufferData(s) as { __set__: true; values: number[] };
    expect(enc.values).toEqual([1, 2, 3]);
  });

  it("roundtrips via restoreBufferData", () => {
    const s = new Set(["b", "a", "c"]);
    const enc = snapshotBufferData(s);
    const rec = restoreBufferData(enc) as Set<unknown>;
    expect(rec instanceof Set).toBe(true);
    expect(Array.from(rec).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("snapshotBufferData — typed arrays", () => {
  it("encodes Float32Array, Int32Array, Uint8Array as plain number[]", () => {
    expect(snapshotBufferData(new Float32Array([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(snapshotBufferData(new Int32Array([4, -5, 6]))).toEqual([4, -5, 6]);
    expect(snapshotBufferData(new Uint8Array([255, 0, 128]))).toEqual([255, 0, 128]);
  });
});

describe("snapshotBufferData — class instances refused", () => {
  it("throws on a value with a non-Object prototype (e.g. a class instance)", () => {
    class MyThing {
      x = 1;
      method() { return this.x; }
    }
    expect(() => snapshotBufferData(new MyThing())).toThrowError(/class instance of "MyThing"/);
  });

  it("throws on a class instance nested inside a plain object", () => {
    class Foo { v = 1 }
    expect(() => snapshotBufferData({ outer: { inner: new Foo() } })).toThrowError(/class instance of "Foo"/);
  });

  it("includes the path to the offending leaf in the error", () => {
    class Q { x = 0 }
    let err: Error | null = null;
    try {
      snapshotBufferData({ a: { b: [new Q()] } });
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    // path should mention .a.b[0]
    expect(err!.message).toContain("a");
    expect(err!.message).toContain("b");
  });
});

describe("snapshotBufferData — realistic buffer shapes", () => {
  it("encodes a TransformBuffer-shaped value (Map<EntityId, {position, yaw, scale}>)", () => {
    const data = {
      byEntity: new Map<number, { position: [number, number, number]; yaw: number; scale: number }>([
        [2, { position: [0, 0, 0], yaw: 0, scale: 1 }],
        [1, { position: [10, 5, -3], yaw: Math.PI, scale: 1 }],
      ]),
    };
    const enc = snapshotBufferData(data) as Record<string, SnapshotValue>;
    expect(Object.keys(enc)).toEqual(["byEntity"]);
    const byEntity = enc.byEntity as Record<string, SnapshotValue>;
    expect(byEntity.__map__).toBe(true);
    const entries = Object.entries(byEntity).filter(([k]) => k !== "__map__");
    expect(entries.map(([k]) => k)).toEqual(["1", "2"]);
    expect((entries[0][1] as Record<string, SnapshotValue>).position).toEqual([10, 5, -3]);
  });

  it("encodes an InputBuffer-shaped value with Sets sorted", () => {
    const data = {
      keys: new Set(["KeyW", "KeyA"]),
      mouseDx: 0,
      mouseDy: 0,
      pointerLocked: true,
      gamepadConnected: false,
      gamepadAxes: { leftX: 0, leftY: -0.5, rightX: 0, rightY: 0 },
      gamepadButtons: new Set<string>(),
    };
    const enc = snapshotBufferData(data) as Record<string, SnapshotValue>;
    expect((enc.keys as { values: string[] }).values).toEqual(["KeyA", "KeyW"]);
    expect((enc.gamepadButtons as { values: string[] }).values).toEqual([]);
    expect(Object.keys(enc.gamepadAxes as Record<string, SnapshotValue>)).toEqual(["leftX", "leftY", "rightX", "rightY"]);
  });

  it("encodes a CharacterController-shape with transitions[] preserving insertion order", () => {
    // Plain arrays must NOT be sorted — index is the identity.
    const transitions = [
      { from: "surfaceRun", to: "airborne", t: 0, reason: "jump" },
      { from: "airborne", to: "surfaceRun", t: 100, reason: "landed" },
    ];
    const enc = snapshotBufferData({ transitions }) as Record<string, SnapshotValue>;
    const encArr = enc.transitions as SnapshotValue[];
    expect((encArr[0] as Record<string, SnapshotValue>).from).toBe("surfaceRun");
    expect((encArr[1] as Record<string, SnapshotValue>).reason).toBe("landed");
  });
});
