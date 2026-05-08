/**
 * Baseline-snapshot tests for the core pipeline transformations.
 *
 * Each test feeds a canonical input into a pure transformation and asserts
 * the output matches a stored snapshot. The first run creates the snapshot
 * file (committed to git); subsequent runs diff against it. Any unintended
 * behavior change shows up as a precise diff in CI / vitest output.
 *
 * To accept new behavior intentionally, run `npx vitest run --update`.
 */

import { describe, it, beforeEach } from "vitest";
import { AssetCatalog } from "../../src/assets/catalog";
import { parseBitmap, buildPalette } from "../../src/map/parseBitmap";
import { splitLayers } from "../../src/map/splitLayers";
import { connectedComponents } from "../../src/map/components";
import { buildHeightmap } from "../../src/map/heightmap";
import { expectBaselined, expectBaselinedApprox } from "../../src/lib/testing/baseline";
import type { SceneFile } from "../../src/core/types";

beforeEach(() => {
  AssetCatalog.reset();
  AssetCatalog.register({
    id: "cactus",
    generate: () => null as any,
    placement: { multiplicity: "fill", on_terrain: ["desert"] },
  });
  AssetCatalog.register({
    id: "shanty",
    generate: () => null as any,
    placement: { multiplicity: "one", attach_to: ["canyon_wall"] },
  });
});

/** A small canonical scene + bitmap for baselines. */
function fixtureScene(): { scene: SceneFile; pixels: Uint8ClampedArray; width: number; height: number } {
  // 5x5 PNG. Colors: desert (#d4a373), canyon_wall (#7c3a1d), cactus (#3a5a40), shanty (#7d6b5d).
  // Layout (row major, top-left origin):
  //   W W . . .       (canyon walls at left)
  //   W . . S .       (shanty next to wall)
  //   . . . . .       (desert)
  //   . . C . .       (cactus mid)
  //   . . . . .
  const W: [number, number, number] = [0x7c, 0x3a, 0x1d];
  const D: [number, number, number] = [0xd4, 0xa3, 0x73];
  const S: [number, number, number] = [0x7d, 0x6b, 0x5d];
  const C: [number, number, number] = [0x3a, 0x5a, 0x40];
  const grid: [number, number, number][][] = [
    [W, W, D, D, D],
    [W, D, D, S, D],
    [D, D, D, D, D],
    [D, D, C, D, D],
    [D, D, D, D, D],
  ];
  const width = 5, height = 5;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = grid[y][x];
      pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255;
    }
  }
  const scene: SceneFile = {
    name: "fixture-5x5",
    tileSize: 1,
    labels: [
      { color: "#d4a373", kind: "terrain", terrain: "desert" },
      { color: "#7c3a1d", kind: "terrain", terrain: "canyon_wall" },
      { color: "#3a5a40", kind: "asset", asset: "cactus" },
      { color: "#7d6b5d", kind: "asset", asset: "shanty" },
    ],
  };
  return { scene, pixels, width, height };
}

describe("Baseline: parseBitmap", () => {
  it("snaps the canonical 5x5 fixture", () => {
    const { scene, pixels, width, height } = fixtureScene();
    const palette = buildPalette(scene);
    const labelMap = parseBitmap({ width, height, pixels, palette, tileSize: 1 });
    expectBaselined("parseBitmap.5x5", {
      width: labelMap.width,
      height: labelMap.height,
      tileSize: labelMap.tileSize,
      data: labelMap.data,
    });
  });
});

describe("Baseline: splitLayers", () => {
  it("snaps terrainMap (with majority-fill) and assetMap for the canonical 5x5", () => {
    const { scene, pixels, width, height } = fixtureScene();
    const palette = buildPalette(scene);
    const labelMap = parseBitmap({ width, height, pixels, palette, tileSize: 1 });
    const split = splitLayers(labelMap);
    expectBaselined("splitLayers.5x5", {
      terrain: split.terrainMap.data,
      asset: split.assetMap.data,
      assetIds: split.assetMap.ids,
    });
  });
});

describe("Baseline: connectedComponents", () => {
  it("snaps component groupings for the canonical 5x5", () => {
    const { scene, pixels, width, height } = fixtureScene();
    const palette = buildPalette(scene);
    const labelMap = parseBitmap({ width, height, pixels, palette, tileSize: 1 });
    const split = splitLayers(labelMap);
    const comps = connectedComponents(split.assetMap);
    expectBaselined("components.5x5", comps.map((c) => ({
      id: c.id,
      assetIdInterned: c.assetIdInterned,
      pixels: c.pixels,
    })));
  });
});

describe("Baseline: buildHeightmap (approx for FP noise)", () => {
  it("snaps heightmap with 4-decimal tolerance", () => {
    const { scene, pixels, width, height } = fixtureScene();
    const palette = buildPalette(scene);
    const labelMap = parseBitmap({ width, height, pixels, palette, tileSize: 1 });
    const split = splitLayers(labelMap);
    const hm = buildHeightmap(split.terrainMap, { blurPasses: 1, jitter: 0, seed: 42 });
    expectBaselinedApprox("heightmap.5x5", hm.data, 4);
  });
});
