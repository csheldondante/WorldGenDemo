/**
 * 3D sweep-and-prune broadphase.
 *
 * Maintains a sorted endpoint list per axis (X, Y, Z). Each item contributes
 * two endpoints per axis (the min and max of its AABB). On `update`, modified
 * endpoints are bubble-sorted back to their correct position — exploiting
 * frame-to-frame coherence so the work per moving endpoint is O(swaps) and
 * usually O(1) in practice (positions and velocities change slowly relative
 * to the spread of the sorted list).
 *
 * Items can be flagged static at insertion. Static items' endpoint values
 * never change, so the per-tick `update` pass skips them — the sort order is
 * preserved automatically across ticks. Large statics (room volumes, walls)
 * don't pay the per-tick scan cost.
 *
 * `candidatePairs()` produces the broadphase candidate set: pairs whose
 * AABBs overlap on all three axes. Sweeps axis X with an active set to
 * enumerate axis-X overlaps, then filters by axis Y and Z overlap via direct
 * AABB checks. This is the classic SAP approach.
 *
 * Item identity is supplied by the caller (any `T` that's stable across
 * insert/remove/update calls); the SAP doesn't own item lifecycle.
 *
 * Runtime-agnostic per src/lib/CLAUDE.md.
 */

export type SAPVec3 = [number, number, number];

interface Endpoint<T> {
  value: number;
  item: T;
  isMin: boolean;
}

/**
 * Sort order: ascending by value; min endpoints sort before max endpoints
 * at equal values. The tiebreak makes the sweep enumerate touching AABBs
 * (a.max == b.min) as an overlapping pair — matches the inclusive AABB
 * overlap convention used everywhere else.
 */
function shouldBeBefore<T>(a: Endpoint<T>, b: Endpoint<T>): boolean {
  if (a.value !== b.value) return a.value < b.value;
  return a.isMin && !b.isMin;
}

interface ItemRecord<T> {
  item: T;
  min: SAPVec3;
  max: SAPVec3;
  isStatic: boolean;
  /**
   * Index of this item's min/max endpoint in each axis's sorted array.
   * `endpointIdx[axis][0]` = min endpoint position; `[axis][1]` = max.
   * Kept current as the bubble-sort runs so that O(1) lookups remain valid.
   */
  endpointIdx: [[number, number], [number, number], [number, number]];
}

export class SweepAndPrune<T> {
  private readonly items = new Map<T, ItemRecord<T>>();
  private readonly axes: [Endpoint<T>[], Endpoint<T>[], Endpoint<T>[]] = [[], [], []];

  size(): number {
    return this.items.size;
  }

  has(item: T): boolean {
    return this.items.has(item);
  }

  /**
   * Add an item with the given AABB. Static items skip per-tick updates;
   * pass `isStatic: true` for level geometry / fixed obstacles.
   */
  insert(item: T, min: SAPVec3, max: SAPVec3, isStatic = false): void {
    if (this.items.has(item)) throw new Error("SAP: item already inserted");
    const rec: ItemRecord<T> = {
      item,
      min: [min[0], min[1], min[2]],
      max: [max[0], max[1], max[2]],
      isStatic,
      endpointIdx: [[0, 0], [0, 0], [0, 0]],
    };
    this.items.set(item, rec);
    for (let axis = 0; axis < 3; axis++) {
      const minIdx = this.insertSorted(axis, { value: min[axis], item, isMin: true });
      const maxIdx = this.insertSorted(axis, { value: max[axis], item, isMin: false });
      rec.endpointIdx[axis] = [minIdx, maxIdx];
    }
  }

  remove(item: T): boolean {
    const rec = this.items.get(item);
    if (!rec) return false;
    // Remove endpoints from each axis. Track the higher index first so the
    // lower removal doesn't shift the higher's position.
    for (let axis = 0; axis < 3; axis++) {
      const [a, b] = rec.endpointIdx[axis];
      const hi = a > b ? a : b;
      const lo = a > b ? b : a;
      this.removeAt(axis, hi);
      this.removeAt(axis, lo);
    }
    this.items.delete(item);
    return true;
  }

  /**
   * Update the AABB of an item. Bubble-sorts modified endpoints back into
   * order. No-op for static items (callers should not animate static items).
   */
  update(item: T, min: SAPVec3, max: SAPVec3): void {
    const rec = this.items.get(item);
    if (!rec) throw new Error("SAP: item not found in update");
    if (rec.isStatic) return;
    for (let axis = 0; axis < 3; axis++) {
      const [minIdx] = rec.endpointIdx[axis];
      // Update values in place, then bubble each to its correct position.
      this.axes[axis][minIdx].value = min[axis];
      this.bubble(axis, minIdx);
      // After bubbling min, find max's current index (it may have shifted by 1
      // if min crossed it). bubble() keeps endpointIdx current.
      this.axes[axis][rec.endpointIdx[axis][1]].value = max[axis];
      this.bubble(axis, rec.endpointIdx[axis][1]);
      rec.min[axis] = min[axis];
      rec.max[axis] = max[axis];
    }
  }

  /**
   * Returns the set of candidate pairs — items whose AABBs overlap on all
   * three axes. Each pair appears once. Order within each pair is the
   * insertion order of the items.
   */
  candidatePairs(): Array<[T, T]> {
    const pairs: Array<[T, T]> = [];
    // Sweep axis X with an active set to enumerate X-overlapping pairs,
    // then filter by Y and Z direct AABB overlap.
    const active = new Set<T>();
    for (const ep of this.axes[0]) {
      if (ep.isMin) {
        const recA = this.items.get(ep.item)!;
        for (const other of active) {
          const recB = this.items.get(other)!;
          // Both must not be static (static-static pairs can't collide).
          if (recA.isStatic && recB.isStatic) continue;
          if (this.aabbOverlap(recA, recB, 1) && this.aabbOverlap(recA, recB, 2)) {
            pairs.push([ep.item, other]);
          }
        }
        active.add(ep.item);
      } else {
        active.delete(ep.item);
      }
    }
    return pairs;
  }

  *[Symbol.iterator](): Iterator<T> {
    for (const item of this.items.keys()) yield item;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // internals
  // ─────────────────────────────────────────────────────────────────────────

  private insertSorted(axis: number, ep: Endpoint<T>): number {
    const arr = this.axes[axis];
    // Linear-scan from end is fine because incremental updates expect this
    // sort to be near-sorted most of the time. For initial insertions of
    // many items, the caller should expect O(N) here; build-once cost.
    let i = arr.length;
    arr.push(ep);
    while (i > 0 && shouldBeBefore(arr[i], arr[i - 1])) {
      const tmp = arr[i - 1];
      arr[i - 1] = arr[i];
      arr[i] = tmp;
      this.recordIndex(axis, arr[i - 1], i - 1);
      this.recordIndex(axis, arr[i], i);
      i--;
    }
    this.recordIndex(axis, arr[i], i);
    return i;
  }

  private removeAt(axis: number, idx: number): void {
    const arr = this.axes[axis];
    arr.splice(idx, 1);
    // Reindex everything from idx onward. O(N) — accept it; removals are
    // rare relative to updates.
    for (let i = idx; i < arr.length; i++) {
      this.recordIndex(axis, arr[i], i);
    }
  }

  private recordIndex(axis: number, ep: Endpoint<T>, idx: number): void {
    const rec = this.items.get(ep.item);
    if (!rec) return;
    rec.endpointIdx[axis][ep.isMin ? 0 : 1] = idx;
  }

  /**
   * Bubble the endpoint at `idx` left or right until the array is sorted by
   * value again. Updates endpointIdx entries for both swapped endpoints.
   * Tie-break: min endpoints sort before max endpoints at equal values, so
   * touching AABBs (max == min) get enumerated as overlapping pairs — matches
   * the inclusive `a.min <= b.max && b.min <= a.max` semantics.
   */
  private bubble(axis: number, idx: number): void {
    const arr = this.axes[axis];
    while (idx > 0 && shouldBeBefore(arr[idx], arr[idx - 1])) {
      const tmp = arr[idx - 1];
      arr[idx - 1] = arr[idx];
      arr[idx] = tmp;
      this.recordIndex(axis, arr[idx - 1], idx - 1);
      this.recordIndex(axis, arr[idx], idx);
      idx--;
    }
    while (idx < arr.length - 1 && shouldBeBefore(arr[idx + 1], arr[idx])) {
      const tmp = arr[idx + 1];
      arr[idx + 1] = arr[idx];
      arr[idx] = tmp;
      this.recordIndex(axis, arr[idx + 1], idx + 1);
      this.recordIndex(axis, arr[idx], idx);
      idx++;
    }
  }

  private aabbOverlap(a: ItemRecord<T>, b: ItemRecord<T>, axis: number): boolean {
    return a.min[axis] <= b.max[axis] && b.min[axis] <= a.max[axis];
  }
}
