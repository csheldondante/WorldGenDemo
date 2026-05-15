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
    expect(sp.worldToUV(-5, 0, -5)).toEqual([0, 0]);
    expect(sp.worldToUV(5, 0, 5)).toEqual([1, 1]);
    expect(sp.worldToUV(0, 0, 0)).toEqual([0.5, 0.5]);
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

  describe("getCurvature", () => {
    function domeHeightmap(width: number, height: number, amplitude: number, tileSize = 1): Heightmap {
      // Smooth dome (Gaussian-ish) centered at the heightmap center. Sampled curvature at the
      // apex should be negative (convex / hilltop).
      const data = new Float32Array(width * height);
      const cx = (width - 1) / 2, cz = (height - 1) / 2;
      const sigma = Math.max(width, height) / 4;
      for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
          const dx = x - cx, dz = z - cz;
          data[z * width + x] = amplitude * Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
        }
      }
      return { width, height, tileSize, data };
    }

    function bowlHeightmap(width: number, height: number, depth: number, tileSize = 1): Heightmap {
      // Negative dome (bowl). Sampled curvature at the deepest point should be positive (concave).
      const data = new Float32Array(width * height);
      const cx = (width - 1) / 2, cz = (height - 1) / 2;
      const sigma = Math.max(width, height) / 4;
      for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
          const dx = x - cx, dz = z - cz;
          data[z * width + x] = -depth * Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma));
        }
      }
      return { width, height, tileSize, data };
    }

    it("flat heightmap → zero curvature in every direction", () => {
      const hm = flatHeightmap(16, 16, 0, 1);
      const sp = new HeightmapSurfaceProvider("flat", hm);
      expect(sp.getCurvature(0.5, 0.5, 1, 0)).toBeCloseTo(0, 6);
      expect(sp.getCurvature(0.5, 0.5, 0, 1)).toBeCloseTo(0, 6);
      expect(sp.getCurvature(0.3, 0.7, 1, 1)).toBeCloseTo(0, 6);
    });

    it("dome apex → negative curvature (convex hill, body thrown off at speed)", () => {
      const hm = domeHeightmap(32, 32, 5, 1);
      const sp = new HeightmapSurfaceProvider("hill", hm);
      expect(sp.getCurvature(0.5, 0.5, 1, 0)).toBeLessThan(0);
      expect(sp.getCurvature(0.5, 0.5, 0, 1)).toBeLessThan(0);
    });

    it("bowl bottom → positive curvature (concave bowl, body pressed into surface)", () => {
      const hm = bowlHeightmap(32, 32, 5, 1);
      const sp = new HeightmapSurfaceProvider("bowl", hm);
      expect(sp.getCurvature(0.5, 0.5, 1, 0)).toBeGreaterThan(0);
      expect(sp.getCurvature(0.5, 0.5, 0, 1)).toBeGreaterThan(0);
    });

    it("curvature is bilinear: doubling direction quadruples result", () => {
      const hm = domeHeightmap(32, 32, 5, 1);
      const sp = new HeightmapSurfaceProvider("hill", hm);
      const base = sp.getCurvature(0.5, 0.5, 1, 0);
      const doubled = sp.getCurvature(0.5, 0.5, 2, 0);
      expect(doubled).toBeCloseTo(4 * base, 4);
    });
  });
});
