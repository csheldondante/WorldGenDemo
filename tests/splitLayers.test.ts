import { describe, it, expect, beforeEach } from "vitest";
import { splitLayers } from "../src/map/splitLayers";
import type { LabelMap } from "../src/core/types";
import { TerrainCatalog } from "../src/terrain/catalog";
import { AssetCatalog } from "../src/assets/catalog";
import { buildPalette } from "../src/map/parseBitmap";

beforeEach(() => {
  AssetCatalog.reset();
  AssetCatalog.register({ id: "tree", generate: () => null as any, placement: {} });
});

function makeLabelMap(width: number, height: number, indices: number[]): LabelMap {
  const palette = buildPalette({
    name: "t", tileSize: 1, labels: [
      { color: "#000001", kind: "terrain", terrain: "desert" },
      { color: "#000002", kind: "terrain", terrain: "water" },
      { color: "#000003", kind: "asset", asset: "tree" },
    ]
  });
  return {
    width, height, tileSize: 1, palette,
    data: Int32Array.from(indices),
  };
}

describe("splitLayers", () => {
  it("keeps terrain pixels intact and zeroes asset entries on terrainMap", () => {
    // 0=desert, 1=water, 2=tree(asset)
    const lm = makeLabelMap(3, 1, [0, 2, 1]);
    const { terrainMap, assetMap } = splitLayers(lm);

    expect(terrainMap.data[0]).toBe(TerrainCatalog.index("desert"));
    expect(terrainMap.data[2]).toBe(TerrainCatalog.index("water"));
    // Tree pixel was filled with neighbor (desert or water — both adjacent at radius 3)
    expect(terrainMap.data[1]).toBeGreaterThanOrEqual(0);

    expect(assetMap.data[0]).toBe(0);
    expect(assetMap.data[1]).toBe(1);
    expect(assetMap.data[2]).toBe(0);
    expect(assetMap.ids[1]).toBe("tree");
  });

  it("fills asset pixel from majority neighbor (desert wins over water)", () => {
    // 5x1: desert desert tree desert water -> tree pixel sees 2 desert + 1 water in radius 3 -> desert
    const lm = makeLabelMap(5, 1, [0, 0, 2, 0, 1]);
    const { terrainMap } = splitLayers(lm);
    expect(terrainMap.data[2]).toBe(TerrainCatalog.index("desert"));
  });

  it("interns asset ids consistently", () => {
    // two distinct labels, same asset id should intern once
    const palette = buildPalette({
      name: "t", tileSize: 1, labels: [
        { color: "#000001", kind: "terrain", terrain: "desert" },
        { color: "#000003", kind: "asset", asset: "tree" },
        { color: "#000004", kind: "asset", asset: "tree" }, // duplicate id different colour
      ]
    });
    const lm: LabelMap = { width: 3, height: 1, tileSize: 1, palette, data: Int32Array.from([0, 1, 2]) };
    const { assetMap } = splitLayers(lm);
    expect(assetMap.ids.length).toBe(2); // [""] + ["tree"]
    expect(assetMap.data[1]).toBe(1);
    expect(assetMap.data[2]).toBe(1);
  });
});
