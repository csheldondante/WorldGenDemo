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
  /** |∂P/∂u| — world meters traversed per unit increase in u, at this sample. Used to convert
   *  a world-frame tangent velocity (m/s) into a UV-parameter velocity (1/s) for `getCurvature`. */
  tangentUNorm: number;
  /** |∂P/∂v| — world meters traversed per unit increase in v, at this sample. */
  tangentVNorm: number;
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

/** Generic surface interface. Implementations: HeightmapSurfaceProvider, Plane/Cylindrical/TorusSurfaceProvider. */
export interface SurfaceProvider {
  readonly id: SurfaceId;
  /** Sample the surface at UV coords in [0,1]². Throws on out-of-range UV. */
  sampleAtUV(u: number, v: number): SurfaceSample;
  /** Project a world XYZ position onto the surface; returns the UV.
   *  Heightmaps and axis-aligned planes ignore y (vertical plumb projection).
   *  Curved surfaces (cylinder, torus, sphere) use y so a character running across
   *  the top of a horizontal log doesn't get teleported to the side when their
   *  XZ position lies on the cylinder's axis line. */
  worldToUV(x: number, y: number, z: number): [number, number];
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
  /**
   * True if the U parameter wraps modulo 1 (closed surface in U) — e.g. cylinders, tori.
   * When true, the integrator folds u_raw modulo 1 instead of treating out-of-bounds as
   * walked-off-edge. Planes/heightmaps return false; v-bounds still apply for cylinders.
   */
  wrapsU(): boolean;
  /** True if V wraps modulo 1 (tori only today). */
  wrapsV(): boolean;
  /**
   * Second fundamental form contracted with a UV direction:
   *   II(u, v, dirU, dirV) = (∂²P/∂u² · N) dirU² + 2(∂²P/∂u∂v · N) dirU·dirV + (∂²P/∂v² · N) dirV²
   *
   * Bilinear in (dirU, dirV). Sign convention:
   *   positive = surface curves into +N (concave / bowl — centripetal toward body)
   *   negative = surface curves into −N (convex / hilltop — centripetal away from body)
   *
   * Two usages:
   *   - Pass UV velocity `(u̇, v̇)` in 1/s → returns centripetal acceleration along N in m/s².
   *     This is what the character controller uses for the leave-surface rule.
   *   - Pass any UV direction → result is bilinear in the inputs (useful for unit tests).
   *
   * Implementations: analytic providers use closed-form derivatives; HeightmapSurfaceProvider
   * uses central differences in UV on the height field.
   */
  getCurvature(u: number, v: number, dirU: number, dirV: number): number;
}

// ---------------------------------------------------------------------------
// HeightmapSurfaceProvider — wraps a Heightmap (the existing pipeline output)
// ---------------------------------------------------------------------------

export class HeightmapSurfaceProvider implements SurfaceProvider {
  readonly id: SurfaceId;
  readonly heightmap: Heightmap;
  readonly worldWidth: number;
  readonly worldDepth: number;
  /**
   * Per-vertex (cell-corner) unit normals, packed (nx, ny, nz). Precomputed
   * from central-difference gradients of the height field at construction.
   * `sampleAtUV` bilinearly interpolates these and renormalizes — the
   * result is a C0-continuous normal across tile boundaries, which removes
   * the per-tile-crossing stutter that the per-sample bilinear-height
   * gradient produced (`∂h/∂v` was piecewise constant within a tile and
   * jumped at tile borders → normal jumped → velocity reprojection lurched
   * the body vertical every N frames where N = ticks-to-cross-one-tile).
   * Memory: 3 floats × W × H. For a 64×64 map that's 48 KB; negligible.
   */
  private readonly vertexNormals: Float32Array;

  constructor(id: SurfaceId, heightmap: Heightmap) {
    this.id = id;
    this.heightmap = heightmap;
    this.worldWidth = heightmap.width * heightmap.tileSize;
    this.worldDepth = heightmap.height * heightmap.tileSize;
    this.vertexNormals = new Float32Array(heightmap.width * heightmap.height * 3);
    this.precomputeVertexNormals();
  }

  /**
   * Compute a smooth unit normal at every grid vertex via central differences
   * over the height field. Edges clamp to one-sided differences. Normal at
   * (i, j) = normalize(-∂h/∂x, 1, -∂h/∂z) — points "up" relative to the
   * height field with magnitude 1.
   */
  private precomputeVertexNormals(): void {
    const W = this.heightmap.width;
    const H = this.heightmap.height;
    const ts = this.heightmap.tileSize;
    const data = this.heightmap.data;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const ileft = i > 0 ? i - 1 : i;
        const iright = i < W - 1 ? i + 1 : i;
        const jdown = j > 0 ? j - 1 : j;
        const jup = j < H - 1 ? j + 1 : j;
        const dxSpan = (iright - ileft) * ts;
        const dzSpan = (jup - jdown) * ts;
        const dhdx = dxSpan > 0 ? (data[j * W + iright] - data[j * W + ileft]) / dxSpan : 0;
        const dhdz = dzSpan > 0 ? (data[jup * W + i] - data[jdown * W + i]) / dzSpan : 0;
        let nx = -dhdx;
        let ny = 1;
        let nz = -dhdz;
        const len = Math.hypot(nx, ny, nz);
        nx /= len; ny /= len; nz /= len;
        const idx = (j * W + i) * 3;
        this.vertexNormals[idx + 0] = nx;
        this.vertexNormals[idx + 1] = ny;
        this.vertexNormals[idx + 2] = nz;
      }
    }
  }

  /**
   * Bilinear-interpolate the precomputed vertex normals at the given UV,
   * then renormalize. Per-vertex normals come from central-difference
   * height gradients at construction time. C0-continuous across cell
   * boundaries — gives smooth FSM-signal inputs (slope angle, curvature)
   * so transitions don't oscillate at cell edges.
   *
   * Restored to bilinear 2026-05-23 after the brief triangulated piecewise-
   * linear experiment caused FSM thrash at the mesa-top climb→surfaceRun
   * transition (= triangle-boundary normal jumps spiked centripetal-detach
   * apparent_N to ~55 m/s² and bounced body off the surface every tick).
   * The disc-CCD math is now slightly approximate on bilinear surfaces
   * (= corners are interpolation artifacts), but body position uses the
   * `contactOffset` buffer model (2026-05-23) so position no longer depends
   * on sample.normal being piecewise-constant.
   */
  private sampleNormalUV(u: number, v: number): [number, number, number] {
    const fx = Math.max(0, Math.min(1, u)) * (this.heightmap.width - 1);
    const fz = Math.max(0, Math.min(1, v)) * (this.heightmap.height - 1);
    const x0 = Math.floor(fx), x1 = Math.min(this.heightmap.width - 1, x0 + 1);
    const z0 = Math.floor(fz), z1 = Math.min(this.heightmap.height - 1, z0 + 1);
    const tx = fx - x0, tz = fz - z0;
    const W = this.heightmap.width;
    const i00 = (z0 * W + x0) * 3;
    const i10 = (z0 * W + x1) * 3;
    const i01 = (z1 * W + x0) * 3;
    const i11 = (z1 * W + x1) * 3;
    const n = this.vertexNormals;
    const w00 = (1 - tx) * (1 - tz);
    const w10 = tx * (1 - tz);
    const w01 = (1 - tx) * tz;
    const w11 = tx * tz;
    let nx = w00 * n[i00] + w10 * n[i10] + w01 * n[i01] + w11 * n[i11];
    let ny = w00 * n[i00 + 1] + w10 * n[i10 + 1] + w01 * n[i01 + 1] + w11 * n[i11 + 1];
    let nz = w00 * n[i00 + 2] + w10 * n[i10 + 2] + w01 * n[i01 + 2] + w11 * n[i11 + 2];
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }

  /** Bilinear height sample at UV. C0-continuous across cell boundaries. */
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

  worldToUV(x: number, _y: number, z: number): [number, number] {
    // Heightmap is single-valued in XZ — vertical plumb projection ignores y.
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
    // Smooth normal: bilinear-interpolated from precomputed per-vertex
    // normals. C0-continuous across tile boundaries — eliminates the per-
    // tile-crossing slope jump that piecewise-bilinear-height gradient
    // produced (see `precomputeVertexNormals` doc above).
    const [nx, ny, nz] = this.sampleNormalUV(u, v);

    // Derive an orthonormal tangent frame from the smooth normal so
    // (tangentU, tangentV, normal) is a clean basis. Project world +X onto
    // the tangent plane for tangentU, then tangentV = normal × tangentU.
    // For a heightmap-style world where the surface is nearly flat (N close
    // to +Y), this gives tangentU ≈ +X and tangentV ≈ +Z — same convention
    // as the previous bilinear-tu-tv form, just continuous now.
    const eXdotN = nx;
    let tuX = 1 - eXdotN * nx;
    let tuY = -eXdotN * ny;
    let tuZ = -eXdotN * nz;
    let tuLen = Math.hypot(tuX, tuY, tuZ) || 1;
    tuX /= tuLen; tuY /= tuLen; tuZ /= tuLen;
    // tangentV = tangentU × normal (matches the original convention where the
    // bilinear-derived ∂P/∂v pointed in +Z on flat ground; N × tU would point -Z
    // and invert the v-direction velocity decomposition).
    const tvX = tuY * nz - tuZ * ny;
    const tvY = tuZ * nx - tuX * nz;
    const tvZ = tuX * ny - tuY * nx;
    const tangentU: [number, number, number] = [tuX, tuY, tuZ];
    const tangentV: [number, number, number] = [tvX, tvY, tvZ];

    // tangentUNorm / tangentVNorm = world meters per UV unit. Position is
    // still bilinear in height, so |∂P/∂u| = √(worldWidth² + (∂H/∂u)²).
    // Compute ∂H/∂u from the bilinear height field with a small UV epsilon
    // (this is for the magnitude only; the *direction* now comes from the
    // smooth normal above). Cheap and keeps UV→world velocity scaling
    // consistent with the height field.
    const eps = 1 / Math.max(this.heightmap.width, this.heightmap.height) * 0.5;
    const dhu = this.sampleHeightUV(u + eps, v) - this.sampleHeightUV(u - eps, v);
    const dhv = this.sampleHeightUV(u, v + eps) - this.sampleHeightUV(u, v - eps);
    const dxSpan = this.worldWidth * (2 * eps);
    const dzSpan = this.worldDepth * (2 * eps);
    const tangentUNorm = Math.hypot(dxSpan, dhu) / (2 * eps);
    const tangentVNorm = Math.hypot(dzSpan, dhv) / (2 * eps);
    const slopeRad = Math.acos(Math.max(0, Math.min(1, ny)));
    return {
      position: [x, y, z],
      normal: [nx, ny, nz],
      tangentU,
      tangentV,
      tangentUNorm,
      tangentVNorm,
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

  wrapsU(): boolean { return false; }
  wrapsV(): boolean { return false; }

  /**
   * Heightmap curvature via central differences on the height field. The
   * height is H(u, v); the surface is parameterized as
   *   P(u, v) = (worldWidth·(u − 0.5), H(u, v), worldDepth·(v − 0.5))
   * so ∂P/∂u = (worldWidth, H_u, 0), ∂P/∂v = (0, H_v, worldDepth),
   *    ∂²P/∂u² = (0, H_uu, 0), ∂²P/∂v² = (0, H_vv, 0), ∂²P/∂u∂v = (0, H_uv, 0).
   * Therefore N · ∂²P/∂u² = N_y · H_uu, and the second fundamental form becomes
   *   II(dirU, dirV) = N_y · (H_uu·dirU² + 2·H_uv·dirU·dirV + H_vv·dirV²).
   *
   * The eps spans at least one grid cell so the second difference resolves the
   * underlying height field rather than its quantization noise.
   */
  getCurvature(u: number, v: number, dirU: number, dirV: number): number {
    const eps = 1 / Math.max(this.heightmap.width, this.heightmap.height);
    const h00 = this.sampleHeightUV(u, v);
    const hUp = this.sampleHeightUV(u + eps, v);
    const hUm = this.sampleHeightUV(u - eps, v);
    const hVp = this.sampleHeightUV(u, v + eps);
    const hVm = this.sampleHeightUV(u, v - eps);
    const hUpVp = this.sampleHeightUV(u + eps, v + eps);
    const hUmVm = this.sampleHeightUV(u - eps, v - eps);
    const hUpVm = this.sampleHeightUV(u + eps, v - eps);
    const hUmVp = this.sampleHeightUV(u - eps, v + eps);
    const Huu = (hUp - 2 * h00 + hUm) / (eps * eps);
    const Hvv = (hVp - 2 * h00 + hVm) / (eps * eps);
    const Huv = (hUpVp - hUpVm - hUmVp + hUmVm) / (4 * eps * eps);
    // The N_y factor comes from the cross-product normalization in sampleAtUV.
    // For a near-flat heightmap N ≈ [0, 1, 0] so N_y ≈ 1; on steep slopes N_y is the cosine
    // of the slope angle, which dampens curvature reported in the normal direction.
    const ny = this.sampleAtUV(u, v).normal[1];
    return ny * (Huu * dirU * dirU + 2 * Huv * dirU * dirV + Hvv * dirV * dirV);
  }
}
