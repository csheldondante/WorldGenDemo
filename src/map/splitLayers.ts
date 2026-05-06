import type { AssetMap, LabelMap, TerrainMap } from "../core/types";
import { ALL_TERRAINS } from "../core/types";
import { TerrainCatalog } from "../terrain/catalog";

export interface SplitOutput {
  terrainMap: TerrainMap;
  assetMap: AssetMap;
}

/**
 * Split a LabelMap into:
 *  - terrainMap: every pixel resolves to a terrain id; asset pixels get filled with majority neighbor terrain.
 *  - assetMap: per-pixel asset id (interned, 0 = none).
 */
export function splitLayers(label: LabelMap): SplitOutput {
  const { width, height, tileSize, palette, data } = label;
  const N = width * height;

  // Pre-resolve palette index -> {terrainIdx, assetInternedId or 0}
  const idToTerrainIdx = new Int32Array(palette.colors.length);
  const idToAssetInterned = new Int32Array(palette.colors.length);
  const assetIds: string[] = [""]; // index 0 = none
  const internMap = new Map<string, number>();
  for (let i = 0; i < palette.colors.length; i++) {
    const kind = palette.kinds[i];
    if (kind === "terrain") {
      idToTerrainIdx[i] = TerrainCatalog.index(palette.terrains[i]!);
      idToAssetInterned[i] = 0;
    } else if (kind === "asset") {
      const aid = palette.assets[i]!;
      let interned = internMap.get(aid);
      if (interned === undefined) {
        interned = assetIds.length;
        assetIds.push(aid);
        internMap.set(aid, interned);
      }
      idToTerrainIdx[i] = -1;
      idToAssetInterned[i] = interned;
    } else {
      idToTerrainIdx[i] = -1;
      idToAssetInterned[i] = 0;
    }
  }

  const terrainData = new Int32Array(N);
  const assetData = new Int32Array(N);

  for (let i = 0; i < N; i++) {
    const lab = data[i];
    if (lab < 0) {
      terrainData[i] = -1;
      assetData[i] = 0;
      continue;
    }
    terrainData[i] = idToTerrainIdx[lab];
    assetData[i] = idToAssetInterned[lab];
  }

  // Majority-fill terrainData where it's < 0 (asset or unknown pixels).
  // Multi-pass radius-growing search; bounded by number of terrain ids.
  const numTerrains = ALL_TERRAINS.length;

  function fillRadius(radius: number): number {
    const counts = new Int32Array(numTerrains);
    let filled = 0;
    const out = terrainData.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (terrainData[i] >= 0) continue;
        counts.fill(0);
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width - 1, x + radius);
        const y0 = Math.max(0, y - radius);
        const y1 = Math.min(height - 1, y + radius);
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const v = terrainData[yy * width + xx];
            if (v >= 0) counts[v]++;
          }
        }
        let bestIdx = -1, bestCount = 0;
        for (let t = 0; t < numTerrains; t++) {
          if (counts[t] > bestCount) {
            bestCount = counts[t];
            bestIdx = t;
          }
        }
        if (bestIdx >= 0) {
          out[i] = bestIdx;
          filled++;
        }
      }
    }
    terrainData.set(out);
    return filled;
  }

  for (const r of [3, 5, 9, 17, 33]) {
    let needsFill = false;
    for (let i = 0; i < N; i++) if (terrainData[i] < 0) { needsFill = true; break; }
    if (!needsFill) break;
    fillRadius(r);
  }

  // Final fallback: any remaining unknowns -> first available terrain
  for (let i = 0; i < N; i++) {
    if (terrainData[i] < 0) terrainData[i] = 0;
  }

  return {
    terrainMap: { width, height, tileSize, data: terrainData },
    assetMap: { width, height, tileSize, data: assetData, ids: assetIds },
  };
}
