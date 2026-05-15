/**
 * Analytic `SurfaceProvider` implementations: plane, cylinder, torus.
 *
 * These exist primarily to support gym scenes (test-bed levels with known,
 * cheap-to-compute geometry) and to give the controller exact curvature values
 * for the Phase 4 centripetal leave-surface rule. They share the same
 * `SurfaceProvider` interface as `HeightmapSurfaceProvider`, so the character
 * controller can run on any of them without changes.
 *
 * Conventions used here (all match `SurfaceProvider` docs):
 *   - UV is [0, 1]² parameterizing the surface patch.
 *   - `getCurvature(u, v, dirU, dirV)` returns the second fundamental form
 *     contracted with `(dirU, dirV)`. Positive = surface curves into +N
 *     (concave/bowl, centripetal toward body); negative = surface curves into
 *     −N (convex/hilltop, centripetal away from body).
 *   - `worldToUV(x, z)` projects vertically (along world up) onto the surface.
 *     For surfaces that aren't a single-valued function of (x, z) — e.g. an
 *     entire cylinder running horizontally — `worldToUV` returns the UV of the
 *     nearest patch point ABOVE the (x, z) query, which is what the character
 *     controller wants when it asks "what's under my feet?".
 */

import type { SurfaceId, SurfaceProvider, SurfaceSample } from "./surfaceProvider";
import { add, addScaled, basisPerpendicular, cross, dot, normalize, scale, sub } from "../lib/math/vec3";
import type { Vec3 } from "../lib/math/quat";

// ---------------------------------------------------------------------------
// Common defaults for sample fields the geometry doesn't drive.
// ---------------------------------------------------------------------------

interface SampleDefaults {
  friction?: number;
  normalInMax?: number;
  normalOutMax?: number;
}

const DEFAULT_FRICTION = 1;
const DEFAULT_NORMAL_IN_MAX = 800;
const DEFAULT_NORMAL_OUT_MAX = 200;

function slopeFromNormal(n: Vec3): number {
  return Math.acos(Math.max(-1, Math.min(1, n[1])));
}

// ---------------------------------------------------------------------------
// PlaneSurfaceProvider
// ---------------------------------------------------------------------------

export interface PlaneSurfaceProviderOpts extends SampleDefaults {
  id: SurfaceId;
  /** World position of the (0, 0) corner of the patch. */
  origin: Vec3;
  /** World offset from (0, 0) to (1, 0). Length = patch size along U. */
  extentU: Vec3;
  /** World offset from (0, 0) to (0, 1). Length = patch size along V. */
  extentV: Vec3;
}

/**
 * Finite parallelogram patch in 3D. UV (0,0) is `origin`; (1,1) is
 * `origin + extentU + extentV`. The normal is `normalize(extentU × extentV)`,
 * which gives a right-handed orientation — pass extentU, extentV such that the
 * cross product points the way you want N to face (typically world-up-ish).
 *
 * Use for flat gyms (extentU and extentV both horizontal) and tilted-slope
 * gyms (rotate extentU upward to give the patch a pitch).
 */
export class PlaneSurfaceProvider implements SurfaceProvider {
  readonly id: SurfaceId;
  readonly origin: Vec3;
  readonly extentU: Vec3;
  readonly extentV: Vec3;
  readonly normal: Vec3;
  readonly tangentU: Vec3;
  readonly tangentV: Vec3;
  readonly tangentUNorm: number;
  readonly tangentVNorm: number;
  readonly slopeRad: number;
  private readonly friction: number;
  private readonly normalInMax: number;
  private readonly normalOutMax: number;
  /** Cached 2x2 inverse of the (extentU.xz, extentV.xz) matrix for worldToUV. */
  private readonly invXZ: { a: number; b: number; c: number; d: number } | null;

  constructor(opts: PlaneSurfaceProviderOpts) {
    this.id = opts.id;
    this.origin = opts.origin;
    this.extentU = opts.extentU;
    this.extentV = opts.extentV;
    this.tangentUNorm = Math.hypot(opts.extentU[0], opts.extentU[1], opts.extentU[2]);
    this.tangentVNorm = Math.hypot(opts.extentV[0], opts.extentV[1], opts.extentV[2]);
    this.tangentU = normalize(opts.extentU);
    this.tangentV = normalize(opts.extentV);
    // Cross product gives a right-handed normal; flip if it points "down" so the
    // character runs on the upward-facing side. Mirrors HeightmapSurfaceProvider.
    const rawN = normalize(cross(opts.extentU, opts.extentV));
    this.normal = rawN[1] < 0 ? [-rawN[0], -rawN[1], -rawN[2]] : rawN;
    this.slopeRad = slopeFromNormal(this.normal);
    this.friction = opts.friction ?? DEFAULT_FRICTION;
    this.normalInMax = opts.normalInMax ?? DEFAULT_NORMAL_IN_MAX;
    this.normalOutMax = opts.normalOutMax ?? DEFAULT_NORMAL_OUT_MAX;
    // worldToUV: solve [extentU.x, extentV.x; extentU.z, extentV.z] · [u; v] = [x − ox; z − oz]
    // for u, v. The 2x2 inverse exists iff the patch isn't seen edge-on from above.
    const a = opts.extentU[0], b = opts.extentV[0];
    const c = opts.extentU[2], d = opts.extentV[2];
    const det = a * d - b * c;
    this.invXZ = Math.abs(det) > 1e-9
      ? { a: d / det, b: -b / det, c: -c / det, d: a / det }
      : null;
  }

  sampleAtUV(u: number, v: number): SurfaceSample {
    const position = add(this.origin, add(scale(this.extentU, u), scale(this.extentV, v)));
    const traversable = u >= 0 && u <= 1 && v >= 0 && v <= 1;
    return {
      position,
      normal: this.normal,
      tangentU: this.tangentU,
      tangentV: this.tangentV,
      tangentUNorm: this.tangentUNorm,
      tangentVNorm: this.tangentVNorm,
      slopeRad: this.slopeRad,
      friction: this.friction,
      normalInMax: this.normalInMax,
      normalOutMax: this.normalOutMax,
      traversable,
    };
  }

  worldToUV(x: number, _y: number, z: number): [number, number] {
    if (!this.invXZ) return [0.5, 0.5]; // degenerate (vertical) plane — caller shouldn't use
    const dx = x - this.origin[0];
    const dz = z - this.origin[2];
    const u = this.invXZ.a * dx + this.invXZ.b * dz;
    const v = this.invXZ.c * dx + this.invXZ.d * dz;
    return [u, v];
  }

  uvToWorld(u: number, v: number): [number, number, number] {
    return add(this.origin, add(scale(this.extentU, u), scale(this.extentV, v)));
  }

  canAttachAt(u: number, v: number): boolean {
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  }

  sampleVelocityAt(_u: number, _v: number): [number, number, number] {
    return [0, 0, 0];
  }

  /** Planes have zero curvature everywhere, by construction. */
  getCurvature(_u: number, _v: number, _dirU: number, _dirV: number): number {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CylindricalSurfaceProvider
// ---------------------------------------------------------------------------

export interface CylindricalSurfaceProviderOpts extends SampleDefaults {
  id: SurfaceId;
  /** Point on the cylinder's axis line, world space. */
  axisOrigin: Vec3;
  /** Axis direction (will be normalized). */
  axisDirection: Vec3;
  /** Radius of the cylinder (m). */
  radius: number;
  /** Length of the cylinder along the axis (m). v ∈ [0, 1] maps to [0, height]. */
  height: number;
  /**
   * False → standing on the OUTSIDE of the cylinder (normal points away from axis).
   * True  → standing on the INSIDE (normal points toward axis). Half-pipe / loop-the-loop case.
   */
  concave: boolean;
}

/**
 * Cylinder patch. UV parameterization:
 *   u ∈ [0, 1] maps around the perimeter (u·2π radians).
 *   v ∈ [0, 1] maps along the axis.
 *   u = 0 corresponds to the `perpA` direction returned by basisPerpendicular(axis), which
 *   is the world +Y-ish direction (so "u = 0" is the top of a horizontal-axis cylinder —
 *   the natural spawn for "running on top of a log").
 *
 * Directional curvature (units: per UV²):
 *   getCurvature(u, v, dirU, dirV) = ε · (2π)² · R · dirU²
 * where ε = +1 (concave) or −1 (convex). Along V (the axis) the surface is flat, so dirV
 * contributes nothing.
 */
export class CylindricalSurfaceProvider implements SurfaceProvider {
  readonly id: SurfaceId;
  readonly axisOrigin: Vec3;
  readonly axisDir: Vec3;
  readonly radius: number;
  readonly height: number;
  readonly concave: boolean;
  private readonly perpA: Vec3;
  private readonly perpB: Vec3;
  private readonly friction: number;
  private readonly normalInMax: number;
  private readonly normalOutMax: number;

  constructor(opts: CylindricalSurfaceProviderOpts) {
    this.id = opts.id;
    this.axisOrigin = opts.axisOrigin;
    this.axisDir = normalize(opts.axisDirection);
    this.radius = opts.radius;
    this.height = opts.height;
    this.concave = opts.concave;
    const basis = basisPerpendicular(this.axisDir);
    this.perpA = basis.perpA;
    this.perpB = basis.perpB;
    this.friction = opts.friction ?? DEFAULT_FRICTION;
    this.normalInMax = opts.normalInMax ?? DEFAULT_NORMAL_IN_MAX;
    this.normalOutMax = opts.normalOutMax ?? DEFAULT_NORMAL_OUT_MAX;
  }

  /** Radial direction at parameter u, unit. */
  private radial(u: number): Vec3 {
    const a = 2 * Math.PI * u;
    return addScaled(scale(this.perpA, Math.cos(a)), this.perpB, Math.sin(a));
  }

  /** Tangent around the perimeter at parameter u, unit. */
  private tangentAround(u: number): Vec3 {
    const a = 2 * Math.PI * u;
    return addScaled(scale(this.perpA, -Math.sin(a)), this.perpB, Math.cos(a));
  }

  sampleAtUV(u: number, v: number): SurfaceSample {
    const radial = this.radial(u);
    // P = axisOrigin + R·radial + v·H·axisDir
    const position = add(
      this.axisOrigin,
      add(scale(radial, this.radius), scale(this.axisDir, v * this.height)),
    );
    const sign = this.concave ? -1 : 1;
    const normal = scale(radial, sign);
    const tangentU = this.tangentAround(u);
    const tangentV = this.axisDir;
    const slopeRad = slopeFromNormal(normal);
    return {
      position,
      normal,
      tangentU,
      tangentV,
      // Cylinder: P(u, v) = origin + R·radial(u) + v·H·axisDir, so |∂P/∂u| = 2π·R and |∂P/∂v| = H.
      tangentUNorm: 2 * Math.PI * this.radius,
      tangentVNorm: this.height,
      slopeRad,
      friction: this.friction,
      normalInMax: this.normalInMax,
      normalOutMax: this.normalOutMax,
      traversable: u >= 0 && u <= 1 && v >= 0 && v <= 1,
    };
  }

  /**
   * Nearest-surface projection of world (x, y, z) onto the cylinder. We split the
   * query's offset from the axis origin into an along-axis component (→ v) and a
   * perpendicular component (→ angle around the cylinder → u). Using the full 3D
   * offset (not just xz) is essential for horizontal-axis cylinders: a character
   * standing on top of the log has (x, y_top, z_axis) — its Y is what tells us it's
   * at u=0 (top), not u=0.25 (side) which is what the XZ-only projection would give.
   */
  worldToUV(x: number, y: number, z: number): [number, number] {
    const queryOffset: Vec3 = [x - this.axisOrigin[0], y - this.axisOrigin[1], z - this.axisOrigin[2]];
    const vAlongAxis = dot(queryOffset, this.axisDir);
    const radialOffset = sub(queryOffset, scale(this.axisDir, vAlongAxis));
    const ra = dot(radialOffset, this.perpA);
    const rb = dot(radialOffset, this.perpB);
    const angle = Math.atan2(rb, ra); // (−π, π]
    const u = ((angle / (2 * Math.PI)) + 1) % 1; // [0, 1)
    const v = vAlongAxis / this.height;
    return [u, v];
  }

  uvToWorld(u: number, v: number): [number, number, number] {
    return add(
      this.axisOrigin,
      add(scale(this.radial(u), this.radius), scale(this.axisDir, v * this.height)),
    );
  }

  canAttachAt(u: number, v: number): boolean {
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  }

  sampleVelocityAt(_u: number, _v: number): [number, number, number] {
    return [0, 0, 0];
  }

  /**
   * Closed-form curvature. With P(u, v) = origin + R·radial(u) + v·H·axisDir:
   *   ∂²P/∂u² = −(2π)²·R·radial(u)
   *   ∂²P/∂v² = 0
   *   ∂²P/∂u∂v = 0
   * N = ε·radial(u) where ε = +1 (convex / outward) or −1 (concave / inward).
   *   N · ∂²P/∂u² = ε·radial · −(2π)²·R·radial = −ε·(2π)²·R
   *
   * → II(dirU, dirV) = −ε·(2π)²·R · dirU²
   *   ε = +1 (convex)  → negative (centripetal away from body, toward axis below).
   *   ε = −1 (concave) → positive (centripetal toward body, away from axis above).
   */
  getCurvature(_u: number, _v: number, dirU: number, _dirV: number): number {
    const eps = this.concave ? -1 : 1; // +1 convex, −1 concave
    return -eps * (2 * Math.PI) * (2 * Math.PI) * this.radius * dirU * dirU;
  }
}

// ---------------------------------------------------------------------------
// TorusSurfaceProvider
// ---------------------------------------------------------------------------

export interface TorusSurfaceProviderOpts extends SampleDefaults {
  id: SurfaceId;
  /** Center of the torus, world space. */
  center: Vec3;
  /** Axis through the donut hole (will be normalized). */
  axisDirection: Vec3;
  /** Major radius — distance from center to the spine of the tube (m). */
  majorRadius: number;
  /** Minor radius — radius of the tube itself (m). */
  minorRadius: number;
  /**
   * False → standing on the OUTSIDE of the donut (normal points away from the spine).
   * True  → standing on the INSIDE of the tube (normal points toward the spine).
   */
  concave: boolean;
}

/**
 * Torus patch. UV parameterization:
 *   u ∈ [0, 1] maps around the major circle (around the donut hole).
 *   v ∈ [0, 1] maps around the minor circle (around the tube cross-section).
 *
 *   P(u, v) = center + (R + r·cos 2πv)·radial_major(u) + r·sin 2πv·axisDir
 *
 * Both principal curvatures are non-trivial; closed-form below.
 */
export class TorusSurfaceProvider implements SurfaceProvider {
  readonly id: SurfaceId;
  readonly center: Vec3;
  readonly axisDir: Vec3;
  readonly majorRadius: number;
  readonly minorRadius: number;
  readonly concave: boolean;
  private readonly perpA: Vec3;
  private readonly perpB: Vec3;
  private readonly friction: number;
  private readonly normalInMax: number;
  private readonly normalOutMax: number;

  constructor(opts: TorusSurfaceProviderOpts) {
    this.id = opts.id;
    this.center = opts.center;
    this.axisDir = normalize(opts.axisDirection);
    this.majorRadius = opts.majorRadius;
    this.minorRadius = opts.minorRadius;
    this.concave = opts.concave;
    const basis = basisPerpendicular(this.axisDir);
    this.perpA = basis.perpA;
    this.perpB = basis.perpB;
    this.friction = opts.friction ?? DEFAULT_FRICTION;
    this.normalInMax = opts.normalInMax ?? DEFAULT_NORMAL_IN_MAX;
    this.normalOutMax = opts.normalOutMax ?? DEFAULT_NORMAL_OUT_MAX;
  }

  /** Direction from torus axis to the spine point at parameter u, unit. */
  private radialMajor(u: number): Vec3 {
    const a = 2 * Math.PI * u;
    return addScaled(scale(this.perpA, Math.cos(a)), this.perpB, Math.sin(a));
  }

  /** Tangent around the major circle at parameter u, unit. */
  private tangentMajor(u: number): Vec3 {
    const a = 2 * Math.PI * u;
    return addScaled(scale(this.perpA, -Math.sin(a)), this.perpB, Math.cos(a));
  }

  sampleAtUV(u: number, v: number): SurfaceSample {
    const av = 2 * Math.PI * v;
    const rm = this.radialMajor(u);
    const tubeRadial = addScaled(scale(rm, Math.cos(av)), this.axisDir, Math.sin(av));
    // P = center + R·rm + r·tubeRadial
    const position = add(
      this.center,
      add(scale(rm, this.majorRadius), scale(tubeRadial, this.minorRadius)),
    );
    const outward = tubeRadial; // already unit (sum of orthogonal cos/sin components)
    const sign = this.concave ? -1 : 1;
    const normal = scale(outward, sign);
    const tangentU = this.tangentMajor(u);
    // Tangent around the minor circle: derivative w.r.t. v, normalized
    //   ∂P/∂v = 2π·(−r·sin 2πv·rm + r·cos 2πv·axisDir) → unit = (−sin·rm + cos·axisDir)
    const tangentV: Vec3 = addScaled(scale(rm, -Math.sin(av)), this.axisDir, Math.cos(av));
    const slopeRad = slopeFromNormal(normal);
    return {
      position,
      normal,
      tangentU,
      tangentV,
      // Torus: |∂P/∂u| = 2π·(R + r·cos 2πv) (depends on v); |∂P/∂v| = 2π·r.
      tangentUNorm: 2 * Math.PI * (this.majorRadius + this.minorRadius * Math.cos(av)),
      tangentVNorm: 2 * Math.PI * this.minorRadius,
      slopeRad,
      friction: this.friction,
      normalInMax: this.normalInMax,
      normalOutMax: this.normalOutMax,
      traversable: u >= 0 && u <= 1 && v >= 0 && v <= 1,
    };
  }

  /**
   * Project (x, z) onto the torus. Procedure: find the point on the major
   * spine closest to (x, 0, z) in the perpendicular plane, then pick the
   * minor-circle angle (v) that puts the surface point above (x, z) (largest
   * world-y). For axis = world +Y the answer is exact; for other axes we use
   * the "above-the-spine" interpretation, which matches what the controller
   * wants when asking "what's under my feet?".
   */
  /**
   * Nearest-surface projection of world (x, y, z) onto the torus. Decompose the
   * 3D offset from center into along-axis and perpendicular-to-axis components;
   * the perpendicular gives the major angle (u). Then compute the minor angle
   * (v) as the angle from the spine point to the query along (axisDir, rmajor).
   * This puts a character standing on TOP of the donut (v=0.25 if axisDir=+Y)
   * at the correct UV regardless of which side of the spine they're on.
   */
  worldToUV(x: number, y: number, z: number): [number, number] {
    const queryOffset: Vec3 = [x - this.center[0], y - this.center[1], z - this.center[2]];
    const vAlongAxis = dot(queryOffset, this.axisDir);
    const radialOffset = sub(queryOffset, scale(this.axisDir, vAlongAxis));
    const ra = dot(radialOffset, this.perpA);
    const rb = dot(radialOffset, this.perpB);
    const angleMajor = Math.atan2(rb, ra);
    const u = ((angleMajor / (2 * Math.PI)) + 1) % 1;
    // Project the query onto the (axisDir, rmajor) plane to find the minor angle.
    // tubeRadial(v=0) is rmajor(u); going positive along axisDir is +v direction.
    const radialMagnitude = Math.hypot(ra, rb);
    const minorAlongRm = radialMagnitude - this.majorRadius; // signed distance from spine along rmajor
    const minorAlongAxis = vAlongAxis;
    const angleMinor = Math.atan2(minorAlongAxis, minorAlongRm);
    const vOut = ((angleMinor / (2 * Math.PI)) + 1) % 1;
    return [u, vOut];
  }

  uvToWorld(u: number, v: number): [number, number, number] {
    return this.sampleAtUV(u, v).position;
  }

  canAttachAt(u: number, v: number): boolean {
    return u >= 0 && u <= 1 && v >= 0 && v <= 1;
  }

  sampleVelocityAt(_u: number, _v: number): [number, number, number] {
    return [0, 0, 0];
  }

  /**
   * Closed-form curvature. With
   *   rmajor(u)  = cos 2πu·perpA + sin 2πu·perpB
   *   outward(u, v) = cos 2πv·rmajor(u) + sin 2πv·axisDir
   *   P(u, v) = center + R·rmajor(u) + r·outward(u, v)
   *
   * Second derivatives:
   *   ∂²P/∂u² = R·(−(2π)²·rmajor) + r·cos 2πv·(−(2π)²·rmajor)
   *           = −(2π)²·(R + r·cos 2πv)·rmajor(u)
   *   ∂²P/∂v² = r·(−(2π)²·outward(u, v))
   *           = −(2π)²·r·outward(u, v)
   *   ∂²P/∂u∂v = ∂/∂v[r·∂outward/∂u] = r·(−sin 2πv)·∂rmajor/∂u·(2π)
   *            = r·(2π)·(−sin 2πv)·(2π)·tangentMajor(u)·(1)
   *            Wait, let me redo this. ∂outward/∂u = cos 2πv · ∂rmajor/∂u, and
   *            ∂/∂v of that = (−sin 2πv)·∂rmajor/∂u · 2π. Multiplied by r:
   *            ∂²P/∂u∂v = −(2π)²·r·sin 2πv · tangentMajor(u)
   *
   * With N = ε·outward (ε = +1 convex, −1 concave) and outward ⊥ tangentMajor:
   *   N · ∂²P/∂u² = ε·outward · −(2π)²·(R + r·cos 2πv)·rmajor
   *              = −ε·(2π)²·(R + r·cos 2πv)·cos 2πv
   *              (because outward·rmajor = cos 2πv, axisDir·rmajor = 0)
   *   N · ∂²P/∂v² = ε·outward · −(2π)²·r·outward = −ε·(2π)²·r
   *   N · ∂²P/∂u∂v = 0  (outward ⊥ tangentMajor)
   *
   * So II(dirU, dirV) = −ε·(2π)² · [(R + r·cos 2πv)·cos 2πv · dirU² + r · dirV²]
   *
   * Sign sanity:
   *   convex (ε = −1), v ≈ 0 (outer equator of donut): II ≈ +(2π)²·[(R+r)·1·dirU² + r·dirV²]
   *     wait — that's positive, but convex should give negative κ. Let me re-check.
   *
   *   Hmm. ε = +1 means concave (normal inward); ε = −1 means convex (normal outward).
   *   Actually I have this swapped. Let me re-read the constructor: when concave=true,
   *   sampleAtUV applies sign = −1 to outward → normal points INWARD. So our ε in this
   *   derivation maps: concave=true → ε=−1, concave=false → ε=+1.
   *
   *   Convex (concave=false, ε=+1), outer equator v=0: II = −(+1)·(2π)²·[(R+r)·dirU² + r·dirV²]
   *     → negative κ in both directions. ✓ matches "convex = curves away" sign.
   *   Concave (concave=true, ε=−1), inside-of-tube at v=0.5 (innermost point of tube facing
   *     spine): cos 2πv = cos π = −1. II = −(−1)·(2π)²·[(R−r)·(−1)·dirU² + r·dirV²]
   *           = (2π)²·[−(R−r)·dirU² + r·dirV²]
   *     → mixed sign! Along the major direction (dirV=0): −(R−r) is negative ← but we expect
   *     positive for concave... Actually wait — this is a saddle inside the tube. The
   *     formula is correct; the user's "concave torus" really IS a saddle in general.
   *
   *   We'll let the controller observe the curvature directly and decide leave/stay.
   */
  getCurvature(_u: number, v: number, dirU: number, dirV: number): number {
    const eps = this.concave ? -1 : 1;
    const cosV = Math.cos(2 * Math.PI * v);
    const k2pi = (2 * Math.PI) * (2 * Math.PI);
    const term1 = (this.majorRadius + this.minorRadius * cosV) * cosV * dirU * dirU;
    const term2 = this.minorRadius * dirV * dirV;
    return -eps * k2pi * (term1 + term2);
  }
}
