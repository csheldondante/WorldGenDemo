import { describe, it, expect } from "vitest";
import { DEFAULT_COLORS, buildDefaultPalette, pickFreeColor } from "../../src/builder/defaults";
import { ALL_TERRAINS } from "../../src/core/types";

describe("DEFAULT_COLORS", () => {
  it("has an entry for every terrain id", () => {
    for (const t of ALL_TERRAINS) {
      expect(DEFAULT_COLORS).toHaveProperty(t);
      expect(DEFAULT_COLORS[t]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("has tundra (which was missing from the canon COLORS map)", () => {
    expect(DEFAULT_COLORS).toHaveProperty("tundra");
  });

  it("all colors are unique", () => {
    const seen = new Set<string>();
    for (const c of Object.values(DEFAULT_COLORS)) {
      const lc = c.toLowerCase();
      expect(seen.has(lc)).toBe(false);
      seen.add(lc);
    }
  });
});

describe("buildDefaultPalette", () => {
  it("includes one entry per terrain id", () => {
    const p = buildDefaultPalette([]);
    expect(p.filter((e) => e.kind === "terrain").length).toBe(ALL_TERRAINS.length);
  });

  it("includes registered asset ids that have default colors", () => {
    const p = buildDefaultPalette(["cactus", "shanty", "unknown_asset"]);
    const assetIds = p.filter((e) => e.kind === "asset").map((e) => e.id);
    expect(assetIds).toContain("cactus");
    expect(assetIds).toContain("shanty");
    expect(assetIds).not.toContain("unknown_asset"); // no default color → omitted
  });
});

describe("pickFreeColor", () => {
  it("returns a color not already in the palette", () => {
    const palette = [
      { kind: "terrain", id: "a", color: "#aaaaaa" },
      { kind: "terrain", id: "b", color: "#bbbbbb" },
    ] as const;
    const c = pickFreeColor(palette);
    expect(c).not.toBe("#aaaaaa");
    expect(c).not.toBe("#bbbbbb");
    expect(c).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("is deterministic for the same input", () => {
    const palette = [{ kind: "terrain", id: "a", color: "#aaaaaa" }] as const;
    expect(pickFreeColor(palette)).toBe(pickFreeColor(palette));
  });
});
