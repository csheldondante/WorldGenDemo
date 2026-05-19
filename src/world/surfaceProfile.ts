import type { ProfileVertex } from "../lib/math/wheelIntersect";
import type { SurfaceProvider } from "./surfaceProvider";

/**
 * Sample a surface along a horizontal line in the velocity plane, producing
 * a (s, y) profile usable by `findCircleProfileIntersections`.
 *
 *   centerX, centerZ — world XZ position around which to sample (s = 0 here).
 *   dirX, dirZ       — unit horizontal direction. +s is along this direction.
 *   halfWidth        — sample window covers s ∈ [−halfWidth, +halfWidth].
 *   step             — sample step in world meters along the line.
 *
 * For a HeightmapSurfaceProvider, the profile is piecewise-linear in s
 * within each cell along an axis-aligned line, and piecewise-quadratic on a
 * diagonal line (because bilinear h restricted to a non-axis-aligned line is
 * degree-2). A piecewise-linear approximation built from fine samples is
 * accurate enough for concave-corner detection — real corners live at cell
 * boundaries where the underlying coefficient changes discontinuously, and
 * any step smaller than the cell width resolves them.
 *
 * Vertices are returned in ascending s order, including both endpoints.
 * Out-of-bounds samples are clamped at the surface's UV edge.
 */
export function buildSurfaceProfile(
  surface: SurfaceProvider,
  centerX: number,
  centerZ: number,
  dirX: number,
  dirZ: number,
  halfWidth: number,
  step: number,
): ProfileVertex[] {
  const N = Math.max(2, Math.ceil((2 * halfWidth) / step));
  const out: ProfileVertex[] = new Array(N + 1);
  for (let k = 0; k <= N; k++) {
    const s = -halfWidth + (k * (2 * halfWidth)) / N;
    const x = centerX + s * dirX;
    const z = centerZ + s * dirZ;
    const [u, v] = surface.worldToUV(x, 0, z);
    const cu = Math.max(0, Math.min(1, u));
    const cv = Math.max(0, Math.min(1, v));
    const world = surface.uvToWorld(cu, cv);
    out[k] = { s, y: world[1] };
  }
  return out;
}
