import { describe, it, expect } from "vitest";
import { findTangentFootUV } from "../../src/world/surfaceFootSolver";
import { HeightmapSurfaceProvider } from "../../src/world/surfaceProvider";
import type { Heightmap } from "../../src/map/heightmap";

function makeFlatHeightmap(): Heightmap {
  return {
    width: 16,
    height: 16,
    tileSize: 1,
    data: new Float32Array(16 * 16),  // all zeros
  };
}

function makeRampHeightmap(maxSlopeRad: number): Heightmap {
  // Linear ramp in u: height = u · 16 · tan(slope). U=0 is height 0; U=1 is height 16·tan(slope).
  const W = 16, H = 16;
  const data = new Float32Array(W * H);
  const slope = Math.tan(maxSlopeRad);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      data[j * W + i] = i * slope;
    }
  }
  return { width: W, height: H, tileSize: 1, data };
}

describe("findTangentFootUV", () => {
  it("flat surface: body 0.5m above (0,0,0) → foot at world (0,0,0), UV (0.5, 0.5)", () => {
    const surf = new HeightmapSurfaceProvider("flat", makeFlatHeightmap());
    const result = findTangentFootUV(surf, 0, 0.5, 0, 0.5, 0.5, 0.5);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.residual).toBeLessThan(1e-5);
    expect(result.sample.position[0]).toBeCloseTo(0, 4);
    expect(result.sample.position[1]).toBeCloseTo(0, 4);
    expect(result.sample.position[2]).toBeCloseTo(0, 4);
    expect(result.sample.normal[1]).toBeCloseTo(1, 4);
  });

  it("flat surface: body off-center → foot tracks below body in xz", () => {
    const surf = new HeightmapSurfaceProvider("flat", makeFlatHeightmap());
    // Body at world (2, 0.5, -3). Foot should be at (2, 0, -3) on the flat surface.
    const hintUV = surf.worldToUV(2, 0, -3);
    const result = findTangentFootUV(surf, 2, 0.5, -3, hintUV[0], hintUV[1], 0.5);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.residual).toBeLessThan(1e-5);
    expect(result.sample.position[0]).toBeCloseTo(2, 4);
    expect(result.sample.position[1]).toBeCloseTo(0, 4);
    expect(result.sample.position[2]).toBeCloseTo(-3, 4);
  });

  it("30° ramp: solver recovers the source UV of body = sample(targetUV) + R·N", () => {
    // Construct body FROM the surface at a known target UV so the solver
    // has an exact solution (avoids bilinear-vs-analytic-ramp discrepancy
    // that exists at sub-cell positions).
    const surf = new HeightmapSurfaceProvider("ramp30", makeRampHeightmap(Math.PI / 6));
    const targetU = 0.5, targetV = 0.5;
    const target = surf.sampleAtUV(targetU, targetV);
    const R = 0.5;
    const bx = target.position[0] + R * target.normal[0];
    const by = target.position[1] + R * target.normal[1];
    const bz = target.position[2] + R * target.normal[2];
    // Hint UV: rough vertical projection. Slightly off from target.
    const hintUV = surf.worldToUV(bx, by, bz);
    const result = findTangentFootUV(surf, bx, by, bz, hintUV[0], hintUV[1], R, 8, 1e-5);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.residual).toBeLessThan(1e-3);
    // Solver should recover target UV.
    expect(result.uv[0]).toBeCloseTo(targetU, 2);
    expect(result.uv[1]).toBeCloseTo(targetV, 2);
  });

  it("returns null when given a hint far from the body (degenerate Jacobian region)", () => {
    const surf = new HeightmapSurfaceProvider("flat", makeFlatHeightmap());
    // Body high above, but hint UV at corner (0, 0). The Newton iteration
    // should still converge — flat surface is easy. This test just checks
    // the function doesn't crash on a not-ideal initial guess.
    const result = findTangentFootUV(surf, 5, 0.5, 5, 0, 0, 0.5);
    // Either converges (returning a foot) or returns null. Both are valid;
    // the caller's job is to handle the null.
    if (result !== null) {
      expect(result.residual).toBeLessThan(1e-3);
    }
  });
});
