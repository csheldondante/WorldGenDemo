import type { AssetMap, Footprint, TerrainId, TerrainMap } from "../core/types";
import { TerrainCatalog } from "../terrain/catalog";
import { convexHull, orientedBoundingBox, principalAxes } from "../core/geom";
import type { Component } from "./components";

const NEIGHBOR_DX = [-1, 1, 0, 0];
const NEIGHBOR_DY = [0, 0, -1, 1];

/**
 * Build a Footprint for a connected component:
 *  - centroid (world coords, +x right, +y forward; world origin at map center)
 *  - convex hull of pixel boundary
 *  - OBB / principal axis from PCA
 *  - per-terrain attachment contacts (perimeter pixels touching that terrain in 4-neighborhood)
 */
export function buildFootprint(
  component: Component,
  assetMap: AssetMap,
  terrainMap: TerrainMap,
  assetId: string,
): Footprint {
  const { width, height, tileSize } = assetMap;
  const cx0 = width * 0.5;
  const cy0 = height * 0.5;
  const px2world = (px: number, py: number): [number, number] => [
    (px - cx0 + 0.5) * tileSize,
    (py - cy0 + 0.5) * tileSize,
  ];

  const points: [number, number][] = [];
  let sumX = 0, sumY = 0;
  for (const idx of component.pixels) {
    const x = idx % width;
    const y = (idx / width) | 0;
    const [wx, wy] = px2world(x, y);
    points.push([wx, wy]);
    sumX += wx; sumY += wy;
  }
  const n = component.pixels.length;
  const centroid: [number, number] = [sumX / n, sumY / n];

  // Convex hull from boundary pixels (interior pixels never affect hull, but cheap to include)
  const hull = convexHull(points);

  // PCA / OBB on all pixels
  const obb = orientedBoundingBox(points);
  const { axisU } = principalAxes(points);

  // Attachment contacts: perimeter pixels in component that have a 4-neighbor with terrain T outside the component
  const inComp = new Set(component.pixels);
  const contacts = new Map<TerrainId, { count: number; sumDx: number; sumDy: number }>();
  for (const idx of component.pixels) {
    const x = idx % width;
    const y = (idx / width) | 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + NEIGHBOR_DX[k];
      const ny = y + NEIGHBOR_DY[k];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = ny * width + nx;
      if (inComp.has(ni)) continue;
      // outside the component — only count if it is a terrain pixel (non-asset)
      if (assetMap.data[ni] !== 0) continue;
      const tIdx = terrainMap.data[ni];
      if (tIdx < 0) continue;
      const tId = TerrainCatalog.fromIndex(tIdx);
      if (!tId) continue;
      const rec = contacts.get(tId) ?? { count: 0, sumDx: 0, sumDy: 0 };
      rec.count += 1;
      rec.sumDx += NEIGHBOR_DX[k];
      rec.sumDy += NEIGHBOR_DY[k];
      contacts.set(tId, rec);
    }
  }
  const attachContacts = new Map<TerrainId, { count: number; direction: [number, number] }>();
  for (const [t, rec] of contacts) {
    const len = Math.hypot(rec.sumDx, rec.sumDy) || 1;
    attachContacts.set(t, { count: rec.count, direction: [rec.sumDx / len, rec.sumDy / len] });
  }

  return {
    componentId: component.id,
    assetId,
    pixels: n,
    area: n * tileSize * tileSize,
    centroid,
    hull,
    obb,
    principalAxis: axisU,
    attachContacts,
  };
}

/** Determine the majority terrain in a 3x3 ring around the component (excluding component pixels). */
export function terrainBeneath(
  component: Component,
  assetMap: AssetMap,
  terrainMap: TerrainMap,
): TerrainId | undefined {
  const { width, height } = assetMap;
  const inComp = new Set(component.pixels);
  const counts = new Map<number, number>();
  for (const idx of component.pixels) {
    const x = idx % width;
    const y = (idx / width) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (inComp.has(ni)) continue;
        const t = terrainMap.data[ni];
        if (t < 0) continue;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
  }
  let best = -1, bestCount = 0;
  for (const [t, c] of counts) {
    if (c > bestCount) { best = t; bestCount = c; }
  }
  return best >= 0 ? TerrainCatalog.fromIndex(best) : undefined;
}
