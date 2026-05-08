import { ALL_TERRAINS, type TerrainId } from "../core/types";
import type { PaletteEntry } from "../buffers/builder";

/**
 * Default colors for every terrain id and the built-in asset ids. Chosen to
 * be visually distinguishable AND to roughly match the rendered material —
 * sand for desert, dark green for forest, etc. Single source of truth: imported
 * by the script that generates sample maps too, so painted scenes match the
 * canon palette out of the box.
 */
export const DEFAULT_COLORS: Record<string, string> = {
  // Terrains
  desert:      "#d4a373",
  tundra:      "#e8edf2",  // light blue/white — was missing from the canyon-desert COLORS map
  forest:      "#3a5a40",
  plains:      "#9bb56b",
  canyon_wall: "#7c3a1d",
  water:       "#3b6e8f",
  path:        "#a89070",

  // Assets
  cactus:      "#5e824a",
  pine:        "#21472e",
  boulder:     "#6b6760",
  shanty:      "#7d6b5d",
  bridge:      "#b58857",
};

/**
 * Build the default palette by enumerating every terrain in ALL_TERRAINS and
 * every asset id present in DEFAULT_COLORS. Asset ids without a default color
 * fall through and need to be added explicitly via the asset menu.
 */
export function buildDefaultPalette(assetIds: readonly string[]): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const t of ALL_TERRAINS) {
    const color = DEFAULT_COLORS[t];
    if (color) out.push({ kind: "terrain", id: t as TerrainId, color });
  }
  for (const a of assetIds) {
    const color = DEFAULT_COLORS[a];
    if (color) out.push({ kind: "asset", id: a, color });
  }
  return out;
}

/**
 * Pick a color that isn't already in `existing`. Used when adding an asset to
 * the palette and its default color clashes (or has no default). Generates
 * pseudorandom-but-stable hues spaced around the wheel.
 */
export function pickFreeColor(existing: readonly PaletteEntry[]): string {
  const used = new Set(existing.map((e) => e.color.toLowerCase()));
  for (let i = 0; i < 64; i++) {
    const h = (i * 137) % 360; // golden-angle-ish for visual spread
    const s = 60 + (i % 3) * 10;
    const l = 45 + ((i * 17) % 25);
    const hex = hslToHex(h, s, l);
    if (!used.has(hex)) return hex;
  }
  return "#888888"; // unreachable under any realistic palette size
}

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100, lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}
