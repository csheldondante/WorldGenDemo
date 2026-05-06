import type { LabelMap, Palette, SceneFile } from "../core/types";
import { NO_LABEL } from "../core/types";
import { TerrainCatalog } from "../terrain/catalog";
import { AssetCatalog } from "../assets/catalog";

export function parseHexColor(hex: string): number {
  const s = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`bad hex color: ${hex}`);
  return parseInt(s, 16) >>> 0;
}

export function buildPalette(scene: SceneFile): Palette {
  const colors: number[] = [];
  const kinds: Palette["kinds"] = [];
  const terrains: Palette["terrains"] = [];
  const assets: Palette["assets"] = [];

  for (const lab of scene.labels) {
    if (lab.kind === "terrain") {
      if (!lab.terrain || !TerrainCatalog.has(lab.terrain)) {
        throw new Error(`scene "${scene.name}": label ${lab.color} references unknown terrain "${lab.terrain}"`);
      }
    } else if (lab.kind === "asset") {
      if (!lab.asset || !AssetCatalog.has(lab.asset)) {
        throw new Error(`scene "${scene.name}": label ${lab.color} references unknown asset "${lab.asset}"`);
      }
    }
    colors.push(parseHexColor(lab.color));
    kinds.push(lab.kind);
    terrains.push(lab.terrain);
    assets.push(lab.asset);
  }
  return { colors, kinds, terrains, assets };
}

function colorDistSq(a: number, b: number): number {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return dr * dr + dg * dg + db * db;
}

export interface ParseInput {
  width: number;
  height: number;
  pixels: Uint8ClampedArray | Uint8Array; // RGBA8 row-major
  palette: Palette;
  tileSize: number;
}

/** Snap each pixel to nearest palette color. Pixels with no colour (alpha < 128) become NO_LABEL. */
export function parseBitmap(input: ParseInput): LabelMap {
  const { width, height, pixels, palette, tileSize } = input;
  if (pixels.length !== width * height * 4) {
    throw new Error(`parseBitmap: expected ${width * height * 4} bytes, got ${pixels.length}`);
  }
  const data = new Int32Array(width * height);
  const n = palette.colors.length;
  for (let p = 0, i = 0; p < pixels.length; p += 4, i++) {
    const a = pixels[p + 3];
    if (a < 128) {
      data[i] = NO_LABEL;
      continue;
    }
    const c = ((pixels[p] & 0xff) << 16) | ((pixels[p + 1] & 0xff) << 8) | (pixels[p + 2] & 0xff);
    let best = 0, bestDist = Infinity;
    for (let k = 0; k < n; k++) {
      const d = colorDistSq(c, palette.colors[k]);
      if (d < bestDist) { bestDist = d; best = k; }
    }
    data[i] = best;
  }
  return { width, height, tileSize, palette, data };
}
