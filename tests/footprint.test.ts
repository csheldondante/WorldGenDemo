import { describe, it, expect } from "vitest";
import { buildFootprint, terrainBeneath } from "../src/map/footprint";
import { connectedComponents } from "../src/map/components";
import type { AssetMap, TerrainMap } from "../src/core/types";
import { TerrainCatalog } from "../src/terrain/catalog";

function aMap(width: number, height: number, data: number[], ids: string[] = ["x"]): AssetMap {
  return { width, height, tileSize: 1, ids: [""].concat(ids), data: Int32Array.from(data) };
}

function tMap(width: number, height: number, data: number[]): TerrainMap {
  return { width, height, tileSize: 1, data: Int32Array.from(data) };
}

describe("buildFootprint", () => {
  it("centroid is at world origin for a centered square", () => {
    // 3x3 grid, single 1x1 asset pixel at center; everything else is desert.
    const desert = TerrainCatalog.index("desert");
    const am = aMap(3, 3, [0,0,0, 0,1,0, 0,0,0]);
    const tm = tMap(3, 3, [desert,desert,desert, desert,-1,desert, desert,desert,desert]);
    const cs = connectedComponents(am);
    const fp = buildFootprint(cs[0], am, tm, "x");
    // map center is 1.5,1.5; pixel center is 1.5,1.5 -> world (0,0)
    expect(fp.centroid[0]).toBeCloseTo(0, 6);
    expect(fp.centroid[1]).toBeCloseTo(0, 6);
    expect(fp.pixels).toBe(1);
    expect(fp.area).toBe(1);
  });

  it("attachContacts captures wall neighbors", () => {
    const desert = TerrainCatalog.index("desert");
    const wall = TerrainCatalog.index("canyon_wall");
    // 3x3: wall on left column, asset in middle column (top), desert elsewhere
    const am = aMap(3, 3, [
      0,1,0,
      0,1,0,
      0,1,0,
    ]);
    const tm = tMap(3, 3, [
      wall, -1, desert,
      wall, -1, desert,
      wall, -1, desert,
    ]);
    const cs = connectedComponents(am);
    const fp = buildFootprint(cs[0], am, tm, "shanty");
    expect(fp.attachContacts.has("canyon_wall")).toBe(true);
    expect(fp.attachContacts.get("canyon_wall")!.count).toBe(3);
    // direction should point left (-1, 0)
    const d = fp.attachContacts.get("canyon_wall")!.direction;
    expect(d[0]).toBeCloseTo(-1, 5);
    expect(d[1]).toBeCloseTo(0, 5);
  });
});

describe("terrainBeneath", () => {
  it("returns the dominant surrounding terrain id", () => {
    const desert = TerrainCatalog.index("desert");
    const water = TerrainCatalog.index("water");
    // Asset at center, surrounded mostly by desert with one water pixel
    const am = aMap(3, 3, [0,0,0, 0,1,0, 0,0,0]);
    const tm = tMap(3, 3, [
      desert, desert, desert,
      desert, -1,    water,
      desert, desert, desert,
    ]);
    const cs = connectedComponents(am);
    expect(terrainBeneath(cs[0], am, tm)).toBe("desert");
  });
});
