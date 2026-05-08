import { describe, it, expect } from "vitest";
import { SpatialHash2D } from "../../../src/lib/spatial/spatialHash";

describe("SpatialHash2D", () => {
  it("inserts and reports size", () => {
    const h = new SpatialHash2D<string>(1.0);
    h.insert("a", 0, 0);
    h.insert("b", 0.5, 0.5);
    expect(h.size()).toBe(2);
  });

  it("queryRadius returns items within the radius", () => {
    const h = new SpatialHash2D<string>(1.0);
    h.insert("a", 0, 0);
    h.insert("b", 0.5, 0.5);
    h.insert("c", 5, 5);
    const got = new Set(h.queryRadius(0, 0, 1));
    expect(got.has("a")).toBe(true);
    expect(got.has("b")).toBe(true);
    expect(got.has("c")).toBe(false);
  });

  it("queryRadius returns nothing for empty index", () => {
    const h = new SpatialHash2D<string>(1.0);
    expect(h.queryRadius(0, 0, 100).length).toBe(0);
  });

  it("handles negative coordinates", () => {
    const h = new SpatialHash2D<string>(1.0);
    h.insert("a", -2.5, -2.5);
    h.insert("b", 0, 0);
    expect(h.queryRadius(-2.5, -2.5, 0.1)).toEqual(["a"]);
  });

  it("queryRadius checks all overlapping cells (boundary case)", () => {
    // Cell size 2.0; point at (1.9, 1.9) is in cell (0,0); query at (2.1, 2.1) in cell (1,1)
    // with radius 0.5 should find it because true Euclidean distance is sqrt(0.08) ≈ 0.283.
    const h = new SpatialHash2D<string>(2.0);
    h.insert("near", 1.9, 1.9);
    const got = h.queryRadius(2.1, 2.1, 0.5);
    expect(got).toContain("near");
  });

  it("filters out items outside the radius even if in the same cell", () => {
    const h = new SpatialHash2D<string>(10.0);
    h.insert("close", 0, 0);
    h.insert("far", 9, 9); // both in cell (0,0)
    expect(h.queryRadius(0, 0, 1)).toEqual(["close"]);
  });

  it("remove drops an item from queries", () => {
    const h = new SpatialHash2D<string>(1.0);
    h.insert("a", 0, 0);
    h.insert("b", 0.5, 0.5);
    h.remove("a");
    expect(h.size()).toBe(1);
    expect(h.queryRadius(0, 0, 5)).toEqual(["b"]);
  });

  it("clear empties the index", () => {
    const h = new SpatialHash2D<string>(1.0);
    h.insert("a", 0, 0);
    h.insert("b", 0.5, 0.5);
    h.clear();
    expect(h.size()).toBe(0);
    expect(h.queryRadius(0, 0, 100)).toEqual([]);
  });

  it("re-inserting the same id replaces its position", () => {
    const h = new SpatialHash2D<string>(1.0);
    h.insert("a", 0, 0);
    h.insert("a", 100, 100);
    expect(h.size()).toBe(1);
    expect(h.queryRadius(0, 0, 1)).not.toContain("a");
    expect(h.queryRadius(100, 100, 1)).toContain("a");
  });
});
