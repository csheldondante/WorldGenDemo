import { describe, it, expect } from "vitest";
import { sceneFromPalette, validatePalette } from "../../src/builder/sceneFromPalette";
import { expectBaselined } from "../../src/lib/testing/baseline";
import type { PaletteEntry } from "../../src/buffers/builder";

const fixture: PaletteEntry[] = [
  { kind: "terrain", id: "desert",      color: "#d4a373" },
  { kind: "terrain", id: "canyon_wall", color: "#7c3a1d" },
  { kind: "terrain", id: "water",       color: "#3b6e8f" },
  { kind: "asset",   id: "cactus",      color: "#5e824a" },
  { kind: "asset",   id: "shanty",      color: "#7d6b5d" },
];

describe("sceneFromPalette", () => {
  it("emits one label per entry, with terrain/asset shape", () => {
    const scene = sceneFromPalette(fixture, "test", 0.6);
    expect(scene.name).toBe("test");
    expect(scene.tileSize).toBe(0.6);
    expect(scene.labels.length).toBe(5);
    const water = scene.labels.find((l) => l.kind === "terrain" && l.terrain === "water")!;
    expect(water.color).toBe("#3b6e8f");
    const cactus = scene.labels.find((l) => l.kind === "asset" && l.asset === "cactus")!;
    expect(cactus.color).toBe("#5e824a");
  });

  it("baselines the canyon-desert-ish fixture", () => {
    expectBaselined("sceneFromPalette.fixture", sceneFromPalette(fixture, "fixture", 1));
  });

  it("drops entries with empty color", () => {
    const p: PaletteEntry[] = [
      ...fixture,
      { kind: "asset", id: "ghost", color: "" },
    ];
    const scene = sceneFromPalette(p, "test", 1);
    expect(scene.labels.length).toBe(5);
  });
});

describe("validatePalette", () => {
  it("returns no errors for a unique palette", () => {
    expect(validatePalette(fixture)).toEqual([]);
  });

  it("flags duplicate colors with the offending ids", () => {
    const dup: PaletteEntry[] = [
      { kind: "terrain", id: "a", color: "#abcdef" },
      { kind: "asset",   id: "b", color: "#abcdef" },
    ];
    const errs = validatePalette(dup);
    expect(errs.length).toBe(1);
    expect(errs[0].kind).toBe("duplicate-color");
    expect(errs[0].color).toBe("#abcdef");
    expect(errs[0].ids.sort()).toEqual(["a", "b"]);
  });

  it("is case-insensitive on color comparison", () => {
    const dup: PaletteEntry[] = [
      { kind: "terrain", id: "a", color: "#ABCDEF" },
      { kind: "asset",   id: "b", color: "#abcdef" },
    ];
    expect(validatePalette(dup).length).toBe(1);
  });
});
