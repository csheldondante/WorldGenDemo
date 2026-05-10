/**
 * Generic surface model. V1 ships only HeightmapSurfaceProvider; the interface
 * is designed so future providers (walls, spheres, custom shapes) plug in
 * without changes to the controller.
 *
 * A surface defines a 2D parameterization (UV) of a 3D shape. Characters
 * attached to the surface live in UV space; world position is derived by
 * sampling. Tangent vectors define a local frame for movement integration.
 */

import type { Heightmap } from "../map/heightmap";

export type SurfaceId = string;

export interface SurfaceSample {
  /** World-space position. */
  position: [number, number, number];
  /** Outward unit normal. */
  normal: [number, number, number];
  /** Unit tangent in U direction. */
  tangentU: [number, number, number];
  /** Unit tangent in V direction. */
  tangentV: [number, number, number];
  /** Slope (radians) between surface normal and world up. */
  slopeRad: number;
  /** Kinetic friction coefficient (rock 1.0, sand 0.6, ice 0.2). Caps tangent force = μ × |normal force|. */
  friction: number;
  /** Max into-surface acceleration the surface can absorb before the character ragdolls (m/s²). */
  normalInMax: number;
  /** Max away-from-surface acceleration the surface can hold against before the character detaches (m/s²). */
  normalOutMax: number;
  /** True if a character can stand here (slope reasonable, terrain not water). */
  traversable: boolean;
}

/** Generic surface interface. Implementations: HeightmapSurfaceProvider. */
export interface SurfaceProvider {
  readonly id: SurfaceId;
  /** Sample the surface at UV coords in [0,1]². Throws on out-of-range UV. */
  sampleAtUV(u: number, v: number): SurfaceSample;
  /** Project a world XZ position onto the surface; returns the UV. */
  worldToUV(x: number, z: number): [number, number];
  /** UV → world XYZ on the surface. Convenience around `sampleAtUV(uv).position`. */
  uvToWorld(u: number, v: number): [number, number, number];
  /** True if the UV is inside [0,1]² and the sample is traversable. */
  canAttachAt(u: number, v: number): boolean;
  /**
   * World-space velocity of the surface anchor at this UV (m/s). For static surfaces returns
   * [0,0,0]. The character solver subtracts this before computing tangent-frame velocity, so
   * moving platforms work seamlessly without controller changes.
   */
  sampleVelocityAt(u: number, v: number): [number, number, number];
}

// ---------------------------------------------------------------------------
// HeightmapSurfaceProvider — wraps a Heightmap (the existing pipeline output)
// ---------------------------------------------------------------------------

export class HeightmapSurfaceProvider implements SurfaceProvider {
  readonly id: SurfaceId;
  readonly heightmap: Heightmap;
  readonly worldWidth: number;
  readonly worldDepth: number;

  constructor(id: SurfaceId, heightmap: Heightmap) {
    this.id = id;
    this.heightmap = heightmap;
    this.worldWidth = heightmap.width * heightmap.tileSize;
    this.worldDepth = heightmap.height * heightmap.tileSize;
  }

  /** Bilinear height sample at UV. */
  private sampleHeightUV(u: number, v: number): number {
    const fx = Math.max(0, Math.min(1, u)) * (this.heightmap.width - 1);
    const fz = Math.max(0, Math.min(1, v)) * (this.heightmap.height - 1);
    const x0 = Math.floor(fx), x1 = Math.min(this.heightmap.width - 1, x0 + 1);
    const z0 = Math.floor(fz), z1 = Math.min(this.heightmap.height - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const h00 = this.heightmap.data[z0 * this.heightmap.width + x0];
    const h10 = this.heightmap.data[z0 * this.heightmap.width + x1];
    const h01 = this.heightmap.data[z1 * this.heightmap.width + x0];
    const h11 = this.heightmap.data[z1 * this.heightmap.width + x1];
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    return h0 * (1 - tz) + h1 * tz;
  }

  worldToUV(x: number, z: number): [number, number] {
    // World origin is the heightmap center; UV (0,0) is the (-X, -Z) corner.
    const u = (x + this.worldWidth * 0.5) / this.worldWidth;
    const v = (z + this.worldDepth * 0.5) / this.worldDepth;
    return [u, v];
  }

  uvToWorld(u: number, v: number): [number, number, number] {
    const x = u * this.worldWidth - this.worldWidth * 0.5;
    const z = v * this.worldDepth - this.worldDepth * 0.5;
    return [x, this.sampleHeightUV(u, v), z];
  }

  sampleAtUV(u: number, v: number): SurfaceSample {
    const [x, y, z] = this.uvToWorld(u, v);
    // Numeric gradient via central differences in UV space (small epsilon).
    const eps = 1 / Math.max(this.heightmap.width, this.heightmap.height) * 0.5;
    const huPlus = this.sampleHeightUV(u + eps, v);
    const huMinus = this.sampleHeightUV(u - eps, v);
    const hvPlus = this.sampleHeightUV(u, v + eps);
    const hvMinus = this.sampleHeightUV(u, v - eps);
    // dPosition/du and dPosition/dv (tangent, not yet unit)
    const dx = this.worldWidth * (2 * eps);   // span in X for 2eps in u
    const dz = this.worldDepth * (2 * eps);   // span in Z for 2eps in v
    const tu: [number, number, number] = [dx, huPlus - huMinus, 0];
    const tv: [number, number, number] = [0, hvPlus - hvMinus, dz];
    // Normal = tu × tv (then normalize, point upward)
    let nx = tu[1] * tv[2] - tu[2] * tv[1];
    let ny = tu[2] * tv[0] - tu[0] * tv[2];
    let nz = tu[0] * tv[1] - tu[1] * tv[0];
    let nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
    // Normalize tangents
    const tuLen = Math.hypot(tu[0], tu[1], tu[2]) || 1;
    const tvLen = Math.hypot(tv[0], tv[1], tv[2]) || 1;
    const tangentU: [number, number, number] = [tu[0] / tuLen, tu[1] / tuLen, tu[2] / tuLen];
    const tangentV: [number, number, number] = [tv[0] / tvLen, tv[1] / tvLen, tv[2] / tvLen];
    const slopeRad = Math.acos(Math.max(0, Math.min(1, ny)));
    return {
      position: [x, y, z],
      normal: [nx, ny, nz],
      tangentU,
      tangentV,
      slopeRad,
      friction: 1,
      normalInMax: 800,
      normalOutMax: 200,
      traversable: u >= 0 && u <= 1 && v >= 0 && v <= 1,
    };
  }

  canAttachAt(u: number, v: number): boolean {
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    return this.sampleAtUV(u, v).traversable;
  }

  sampleVelocityAt(_u: number, _v: number): [number, number, number] {
    // Heightmap is a static surface; future moving providers (platforms, vehicles) override.
    return [0, 0, 0];
  }
}
