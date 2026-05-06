import type { AssetMap } from "../core/types";

export interface Component {
  id: number;        // 1-based component id
  assetIdInterned: number;
  pixels: number[];  // pixel indices (y*w + x)
}

/**
 * Two-pass union-find over the assetMap. Background (0) is ignored.
 * Two pixels join only if they share the same asset id. 4-connectivity.
 */
export function connectedComponents(assetMap: AssetMap): Component[] {
  const { width, height, data } = assetMap;
  const N = width * height;
  const parent = new Int32Array(N);
  const compAsset = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = i;

  function find(i: number): number {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    let j = i;
    while (parent[j] !== r) {
      const next = parent[j];
      parent[j] = r;
      j = next;
    }
    return r;
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // First pass: union with N + W neighbors when same asset id.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const a = data[i];
      if (a === 0) continue;
      compAsset[i] = a;
      if (x > 0 && data[i - 1] === a) union(i, i - 1);
      if (y > 0 && data[i - width] === a) union(i, i - width);
    }
  }

  // Second pass: collect components by canonical root.
  const map = new Map<number, Component>();
  for (let i = 0; i < N; i++) {
    if (data[i] === 0) continue;
    const root = find(i);
    let c = map.get(root);
    if (!c) {
      c = { id: 0, assetIdInterned: data[i], pixels: [] };
      map.set(root, c);
    }
    c.pixels.push(i);
  }
  // Assign 1-based ids in stable order
  let next = 1;
  return Array.from(map.values())
    .sort((a, b) => (a.pixels[0] - b.pixels[0]))
    .map((c) => ({ ...c, id: next++ }));
}
