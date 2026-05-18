import { describe, it, expect } from "vitest";
import { SweepAndPrune } from "../../../src/lib/spatial/sweepAndPrune";

function setOfPairs(pairs: Array<[string, string]>): Set<string> {
  const out = new Set<string>();
  for (const [a, b] of pairs) {
    out.add(a < b ? `${a}|${b}` : `${b}|${a}`);
  }
  return out;
}

describe("SweepAndPrune", () => {
  it("empty SAP has no pairs", () => {
    const sap = new SweepAndPrune<string>();
    expect(sap.size()).toBe(0);
    expect(sap.candidatePairs()).toEqual([]);
  });

  it("two non-overlapping AABBs produce no pair", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    sap.insert("b", [5, 5, 5], [6, 6, 6]);
    expect(sap.candidatePairs()).toEqual([]);
  });

  it("two overlapping AABBs produce one pair", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    sap.insert("b", [0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    expect(setOfPairs(sap.candidatePairs())).toEqual(new Set(["a|b"]));
  });

  it("axis-X overlap but axis-Y separated → no pair", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    sap.insert("b", [0.5, 5, 0], [1.5, 6, 1]); // overlaps X and Z but not Y
    expect(sap.candidatePairs()).toEqual([]);
  });

  it("axis-X overlap but axis-Z separated → no pair", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    sap.insert("b", [0.5, 0.5, 5], [1.5, 1.5, 6]);
    expect(sap.candidatePairs()).toEqual([]);
  });

  it("three pairwise-overlapping AABBs produce 3 pairs", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [2, 2, 2]);
    sap.insert("b", [1, 1, 1], [3, 3, 3]);
    sap.insert("c", [0.5, 0.5, 0.5], [2.5, 2.5, 2.5]);
    expect(setOfPairs(sap.candidatePairs())).toEqual(new Set(["a|b", "a|c", "b|c"]));
  });

  it("static-static pairs are skipped (level geometry can't collide with itself)", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("wall1", [0, 0, 0], [10, 1, 1], true);
    sap.insert("wall2", [5, 0.5, 0.5], [15, 2, 2], true);
    expect(sap.candidatePairs()).toEqual([]);
  });

  it("static-dynamic pair is produced", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("wall", [0, 0, 0], [10, 1, 1], true);
    sap.insert("player", [5, 0.5, 0.5], [6, 1.5, 1.5]);
    expect(setOfPairs(sap.candidatePairs())).toEqual(new Set(["player|wall"]));
  });

  it("update moves an item out of overlap → pair disappears", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    sap.insert("b", [0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    expect(setOfPairs(sap.candidatePairs())).toEqual(new Set(["a|b"]));
    sap.update("b", [10, 10, 10], [11, 11, 11]);
    expect(sap.candidatePairs()).toEqual([]);
  });

  it("update moves an item into overlap → pair appears", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    sap.insert("b", [10, 10, 10], [11, 11, 11]);
    expect(sap.candidatePairs()).toEqual([]);
    sap.update("b", [0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    expect(setOfPairs(sap.candidatePairs())).toEqual(new Set(["a|b"]));
  });

  it("update on a static item is a no-op", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("wall", [0, 0, 0], [1, 1, 1], true);
    sap.insert("player", [10, 10, 10], [11, 11, 11]);
    expect(sap.candidatePairs()).toEqual([]);
    // Caller mistakenly tries to animate the wall. Should be ignored.
    sap.update("wall", [10, 10, 10], [11, 11, 11]);
    expect(sap.candidatePairs()).toEqual([]);
  });

  it("remove drops an item and its pairs", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    sap.insert("b", [0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    sap.insert("c", [0.7, 0.7, 0.7], [1.7, 1.7, 1.7]);
    expect(setOfPairs(sap.candidatePairs())).toEqual(new Set(["a|b", "a|c", "b|c"]));
    sap.remove("b");
    expect(setOfPairs(sap.candidatePairs())).toEqual(new Set(["a|c"]));
    expect(sap.size()).toBe(2);
  });

  it("inserting a duplicate item throws", () => {
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    expect(() => sap.insert("a", [2, 2, 2], [3, 3, 3])).toThrow();
  });

  it("updating an unknown item throws", () => {
    const sap = new SweepAndPrune<string>();
    expect(() => sap.update("ghost", [0, 0, 0], [1, 1, 1])).toThrow();
  });

  it("incremental updates over many frames preserve correctness", () => {
    // Two items slowly approaching each other along X. The pair should appear
    // exactly when their AABBs overlap on all three axes.
    const sap = new SweepAndPrune<string>();
    sap.insert("a", [0, 0, 0], [1, 1, 1]);
    sap.insert("b", [10, 0.5, 0.5], [11, 1.5, 1.5]);
    let overlapsStarted = -1;
    for (let frame = 0; frame < 20; frame++) {
      // Move b leftward 0.5 units per frame.
      const x = 10 - frame * 0.5;
      sap.update("b", [x, 0.5, 0.5], [x + 1, 1.5, 1.5]);
      const hasPair = sap.candidatePairs().length > 0;
      if (hasPair && overlapsStarted < 0) overlapsStarted = frame;
    }
    // Overlap on X starts when b.maxX(=x+1) >= a.minX(=0) AND b.minX(=x) <= a.maxX(=1).
    // i.e. x <= 1 AND x >= -1. b's min crosses a.maxX=1 when 10 - 0.5*frame <= 1
    // → frame >= 18. So pair appears at frame 18.
    expect(overlapsStarted).toBe(18);
  });

  it("many items, sparse: no false positives", () => {
    // 20 unit cubes spread 5 units apart along X — none should overlap.
    const sap = new SweepAndPrune<string>();
    for (let i = 0; i < 20; i++) {
      sap.insert(`cube${i}`, [i * 5, 0, 0], [i * 5 + 1, 1, 1]);
    }
    expect(sap.candidatePairs()).toEqual([]);
  });

  it("many items, dense: correct pair count via brute force", () => {
    // Random AABBs in [0, 5] cube; compare SAP output to brute-force overlap check.
    const N = 30;
    const items: Array<{ id: string; min: [number, number, number]; max: [number, number, number] }> = [];
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const sap = new SweepAndPrune<string>();
    for (let i = 0; i < N; i++) {
      const min: [number, number, number] = [rand() * 5, rand() * 5, rand() * 5];
      const size = 0.3 + rand() * 0.5;
      const max: [number, number, number] = [min[0] + size, min[1] + size, min[2] + size];
      const id = `i${i}`;
      items.push({ id, min, max });
      sap.insert(id, min, max);
    }
    const brute = new Set<string>();
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = items[i], b = items[j];
        if (
          a.min[0] <= b.max[0] && b.min[0] <= a.max[0] &&
          a.min[1] <= b.max[1] && b.min[1] <= a.max[1] &&
          a.min[2] <= b.max[2] && b.min[2] <= a.max[2]
        ) {
          brute.add(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
        }
      }
    }
    expect(setOfPairs(sap.candidatePairs())).toEqual(brute);
  });
});
