import { describe, it, expect } from "vitest";
import { HeightmapSurfaceProvider } from "../../src/world/surfaceProvider";
import type { Heightmap } from "../../src/map/heightmap";

function flatHeightmap(width: number, height: number, h: number, tileSize = 1): Heightmap {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = h;
  return { width, height, tileSize, data };
}

function rampHeightmap(width: number, height: number, slopeAlongX: number, tileSize = 1): Heightmap {
  const data = new Float32Array(width * height);
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      data[z * width + x] = x * slopeAlongX;
    }
  }
  return { width, height, tileSize, data };
}

describe("HeightmapSurfaceProvider", () => {
  it("worldToUV / uvToWorld round-trip on the corners", () => {
    const hm = flatHeightmap(10, 10, 5, 1);
    const sp = new HeightmapSurfaceProvider("hm", hm);
    // World (-W/2, -D/2) is UV (0, 0); world (+W/2, +D/2) is UV (1, 1).
    expect(sp.worldToUV(-5, -5)).toEqual([0, 0]);
    expect(sp.worldToUV(5, 5)).toEqual([1, 1]);
    expect(sp.worldToUV(0, 0)).toEqual([0.5, 0.5]);
  });

  it("uvToWorld returns the expected y for a flat heightmap", () => {
    const hm = flatHeightmap(8, 8, 2.5, 1);
    const sp = new HeightmapSurfaceProvider("hm", hm);
    const [, y] = sp.uvToWorld(0.5, 0.5);
    expect(y).toBeCloseTo(2.5, 6);
  });

  it("sampleAtUV on a flat surface gives normal=Y-up and slope=0", () => {
    const hm = flatHeightmap(8, 8, 1, 1);
    const sp = new HeightmapSurfaceProvider("hm", hm);
    const s = sp.sampleAtUV(0.5, 0.5);
    expect(s.normal[1]).toBeCloseTo(1, 5);
    expect(s.slopeRad).toBeCloseTo(0, 5);
    expect(s.traversable).toBe(true);
  });

  it("sampleAtUV on a ramped surface produces a non-zero slope", () => {
    // Slope of 1 unit per tile along X, in a heightmap with tileSize=1.
    // dh/dx = 1 → tilt 45° → slopeRad = π/4 ≈ 0.785.
    const hm = rampHeightmap(16, 16, 1, 1);
    const sp = new HeightmapSurfaceProvider("hm", hm);
    const s = sp.sampleAtUV(0.5, 0.5);
    expect(s.slopeRad).toBeGreaterThan(0.5);
    expect(s.slopeRad).toBeLessThan(1.1);
    // Normal tilts toward -X (since heights rise going +X)
    expect(s.normal[0]).toBeLessThan(0);
  });

  it("canAttachAt returns false outside [0,1]²", () => {
    const hm = flatHeightmap(4, 4, 0, 1);
    const sp = new HeightmapSurfaceProvider("hm", hm);
    expect(sp.canAttachAt(-0.1, 0.5)).toBe(false);
    expect(sp.canAttachAt(0.5, 1.1)).toBe(false);
    expect(sp.canAttachAt(0.5, 0.5)).toBe(true);
  });
});
