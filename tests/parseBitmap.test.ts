import { describe, it, expect, beforeEach } from "vitest";
import { parseBitmap, buildPalette, parseHexColor } from "../src/map/parseBitmap";
import type { SceneFile } from "../src/core/types";
import { AssetCatalog } from "../src/assets/catalog";

beforeEach(() => {
  AssetCatalog.reset();
  AssetCatalog.register({
    id: "cactus",
    generate: () => ({ geometry: null as any, material: null as any }),
    placement: { multiplicity: "fill", on_terrain: ["desert"] },
  });
});

const scene: SceneFile = {
  name: "test",
  tileSize: 1,
  labels: [
    { color: "#ff0000", kind: "terrain", terrain: "desert" },
    { color: "#0000ff", kind: "terrain", terrain: "water" },
    { color: "#00ff00", kind: "asset", asset: "cactus" },
  ],
};

describe("parseHexColor", () => {
  it("parses 6-digit hex with leading #", () => {
    expect(parseHexColor("#ff0000")).toBe(0xff0000);
    expect(parseHexColor("ff00aa")).toBe(0xff00aa);
  });
  it("rejects bad input", () => {
    expect(() => parseHexColor("xyz")).toThrow();
    expect(() => parseHexColor("#fff")).toThrow();
  });
});

describe("buildPalette", () => {
  it("rejects unknown terrain", () => {
    expect(() =>
      buildPalette({ name: "x", tileSize: 1, labels: [{ color: "#ff0000", kind: "terrain", terrain: "wormhole" as any }] })
    ).toThrow(/unknown terrain/);
  });
  it("rejects unknown asset", () => {
    expect(() =>
      buildPalette({ name: "x", tileSize: 1, labels: [{ color: "#00ff00", kind: "asset", asset: "ghost" }] })
    ).toThrow(/unknown asset/);
  });
});

describe("parseBitmap", () => {
  it("snaps each pixel to nearest palette colour", () => {
    const palette = buildPalette(scene);
    // 2x1 image: pure red, slightly-off blue
    const pixels = new Uint8Array([
      255, 0, 0, 255,
      10, 10, 240, 255,
    ]);
    const lm = parseBitmap({ width: 2, height: 1, pixels, palette, tileSize: 1 });
    expect(lm.data[0]).toBe(0); // red -> desert
    expect(lm.data[1]).toBe(1); // near blue -> water
  });

  it("treats low-alpha pixels as NO_LABEL", () => {
    const palette = buildPalette(scene);
    const pixels = new Uint8Array([255, 0, 0, 0]);
    const lm = parseBitmap({ width: 1, height: 1, pixels, palette, tileSize: 1 });
    expect(lm.data[0]).toBe(-1);
  });
});
