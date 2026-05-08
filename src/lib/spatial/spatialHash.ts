/**
 * 2D uniform-grid spatial hash for points.
 *
 * Cell size is fixed at construction; points are bucketed by floor(x/cellSize),
 * floor(y/cellSize). Radius queries scan all cells overlapping the bounding
 * square of the radius and filter by true Euclidean distance.
 *
 * Sweet spot: many small queries with radius on the order of cellSize. Pick
 * cellSize ≈ expected query radius for best behavior. For very heterogeneous
 * scales, prefer a quadtree.
 *
 * Runtime-agnostic.
 */
export class SpatialHash2D<T> {
  private readonly cellSize: number;
  private readonly invCell: number;
  private readonly buckets = new Map<string, Map<T, [number, number]>>();
  private readonly itemCell = new Map<T, string>();

  constructor(cellSize: number) {
    if (cellSize <= 0) throw new Error("cellSize must be positive");
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private cellOf(x: number, y: number): [number, number] {
    return [Math.floor(x * this.invCell), Math.floor(y * this.invCell)];
  }

  insert(item: T, x: number, y: number): void {
    // If already present, remove from the old cell first.
    const prevKey = this.itemCell.get(item);
    if (prevKey !== undefined) {
      const prev = this.buckets.get(prevKey);
      prev?.delete(item);
      if (prev && prev.size === 0) this.buckets.delete(prevKey);
    }
    const [cx, cy] = this.cellOf(x, y);
    const k = this.key(cx, cy);
    let bucket = this.buckets.get(k);
    if (!bucket) {
      bucket = new Map();
      this.buckets.set(k, bucket);
    }
    bucket.set(item, [x, y]);
    this.itemCell.set(item, k);
  }

  remove(item: T): boolean {
    const k = this.itemCell.get(item);
    if (k === undefined) return false;
    const bucket = this.buckets.get(k);
    bucket?.delete(item);
    if (bucket && bucket.size === 0) this.buckets.delete(k);
    this.itemCell.delete(item);
    return true;
  }

  clear(): void {
    this.buckets.clear();
    this.itemCell.clear();
  }

  size(): number {
    return this.itemCell.size;
  }

  /**
   * Items within (Euclidean) radius of (x, y).
   */
  queryRadius(x: number, y: number, radius: number): T[] {
    const r2 = radius * radius;
    const [cxMin, cyMin] = this.cellOf(x - radius, y - radius);
    const [cxMax, cyMax] = this.cellOf(x + radius, y + radius);
    const out: T[] = [];
    for (let cx = cxMin; cx <= cxMax; cx++) {
      for (let cy = cyMin; cy <= cyMax; cy++) {
        const bucket = this.buckets.get(this.key(cx, cy));
        if (!bucket) continue;
        for (const [item, [ix, iy]] of bucket) {
          const dx = ix - x, dy = iy - y;
          if (dx * dx + dy * dy <= r2) out.push(item);
        }
      }
    }
    return out;
  }

  *[Symbol.iterator](): IterableIterator<T> {
    for (const item of this.itemCell.keys()) yield item;
  }
}
