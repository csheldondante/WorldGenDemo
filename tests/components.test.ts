import { describe, it, expect } from "vitest";
import { connectedComponents } from "../src/map/components";
import type { AssetMap } from "../src/core/types";

function mkMap(width: number, height: number, ids: string[], data: number[]): AssetMap {
  return { width, height, tileSize: 1, ids: [""].concat(ids), data: Int32Array.from(data) };
}

describe("connectedComponents", () => {
  it("merges 4-connected pixels of the same id", () => {
    // 3x3, all 1s
    const am = mkMap(3, 3, ["tree"], [1,1,1,1,1,1,1,1,1]);
    const cs = connectedComponents(am);
    expect(cs.length).toBe(1);
    expect(cs[0].pixels.length).toBe(9);
  });

  it("does not merge across diagonal-only contact", () => {
    // 2x2: 1 0 / 0 1 → two singletons
    const am = mkMap(2, 2, ["tree"], [1,0,0,1]);
    const cs = connectedComponents(am);
    expect(cs.length).toBe(2);
  });

  it("separates different asset ids", () => {
    // 1 1 2 2 (different ids touching) → two components
    const am = mkMap(4, 1, ["a","b"], [1,1,2,2]);
    const cs = connectedComponents(am);
    expect(cs.length).toBe(2);
    const aComp = cs.find((c) => c.assetIdInterned === 1)!;
    const bComp = cs.find((c) => c.assetIdInterned === 2)!;
    expect(aComp.pixels.length).toBe(2);
    expect(bComp.pixels.length).toBe(2);
  });

  it("ignores zero (background) pixels", () => {
    const am = mkMap(3, 1, ["tree"], [0,0,0]);
    expect(connectedComponents(am).length).toBe(0);
  });

  it("assigns stable 1-based ids", () => {
    const am = mkMap(4, 1, ["a"], [1,0,1,1]);
    const cs = connectedComponents(am);
    expect(cs[0].id).toBe(1);
    expect(cs[1].id).toBe(2);
  });
});
