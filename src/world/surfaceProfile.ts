import type { ProfileVertex } from "../lib/math/wheelIntersect";
import type { SurfaceProvider } from "./surfaceProvider";

/**
 * Sample a surface along a line in the velocity plane, producing a (s, y)
 * profile usable by `findCircleProfileIntersections`.
 *
 * The velocity plane is defined by two unit vectors at the body:
 *   - `dir` (the "horizontal" direction): unit vector along which the body
 *     intends to travel, lying in the local surface tangent plane.
 *   - `up`  (the "vertical" direction): unit vector perpendicular to the
 *     local tangent plane — the surface normal at the body's location.
 *     For radial-gravity scenes (sphere, cylinder, torus) this is the
 *     local radial direction; for heightmaps it is the bilinear-gradient
 *     normal at the body's sample.
 *
 * The 2D coordinate system of the returned profile:
 *   - `s` = signed displacement along `dir` from the body.
 *   - `y` = signed displacement along `up` from the body (= projection of
 *     `(surfacePoint − body)` onto `up`). Surface samples generally have
 *     y ≤ 0 near the body (it's "below" the disc center, R away).
 *
 * Using `sample.normal` as the `up` axis (rather than world-Y) makes the
 * profile gravity-agnostic: it works on heightmaps with world-Y gravity,
 * spheres with radial gravity, cylinders with axial gravity, etc. The
 * disc-vs-profile geometry is purely about the surface, not about which
 * way "down" is.
 *
 * Vertices are returned in ascending s order. Out-of-bounds samples are
 * clamped at the surface's UV edge.
 */
export function buildSurfaceProfile(
  surface: SurfaceProvider,
  bodyX: number,
  bodyY: number,
  bodyZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  upX: number,
  upY: number,
  upZ: number,
  halfWidth: number,
  step: number,
): ProfileVertex[] {
  const N = Math.max(2, Math.ceil((2 * halfWidth) / step));
  const out: ProfileVertex[] = new Array(N + 1);
  for (let k = 0; k <= N; k++) {
    const s = -halfWidth + (k * (2 * halfWidth)) / N;
    // Sample line lives in the velocity plane: body + s·dir.
    const sx = bodyX + s * dirX;
    const sy = bodyY + s * dirY;
    const sz = bodyZ + s * dirZ;
    const [u, v] = surface.worldToUV(sx, sy, sz);
    const cu = Math.max(0, Math.min(1, u));
    const cv = Math.max(0, Math.min(1, v));
    const world = surface.uvToWorld(cu, cv);
    // Project the surface point's offset from the body onto the up axis.
    const yProj =
      (world[0] - bodyX) * upX +
      (world[1] - bodyY) * upY +
      (world[2] - bodyZ) * upZ;
    out[k] = { s, y: yProj };
  }
  return out;
}
