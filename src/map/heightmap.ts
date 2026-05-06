import type { TerrainMap } from "../core/types";
import { TerrainCatalog } from "../terrain/catalog";

export interface Heightmap {
  width: number;
  height: number;
  tileSize: number;
  data: Float32Array;
}

/**
 * Convert a TerrainMap to a heightmap by per-pixel elevation lookup, then a tiny box blur.
 * A small jitter is added for visual interest.
 */
export function buildHeightmap(terrain: TerrainMap, opts?: { blurPasses?: number; jitter?: number; seed?: number }): Heightmap {
  const { width, height, tileSize, data } = terrain;
  const N = width * height;
  const raw = new Float32Array(N);
  const tableSize = 32;
  const elev = new Float32Array(tableSize);
  for (let i = 0; i < tableSize; i++) {
    const t = TerrainCatalog.fromIndex(i);
    elev[i] = t ? TerrainCatalog.get(t).elevation : 0;
  }
  for (let i = 0; i < N; i++) raw[i] = elev[data[i]] || 0;

  const jitter = opts?.jitter ?? 0.04;
  if (jitter > 0) {
    let s = (opts?.seed ?? 1234) >>> 0;
    for (let i = 0; i < N; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      raw[i] += ((s / 4294967296) - 0.5) * jitter;
    }
  }

  const passes = opts?.blurPasses ?? 2;
  let cur = raw;
  let next = new Float32Array(N);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0, count = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            sum += cur[ny * width + nx];
            count++;
          }
        }
        next[y * width + x] = sum / count;
      }
    }
    [cur, next] = [next, cur];
  }
  return { width, height, tileSize, data: cur };
}
