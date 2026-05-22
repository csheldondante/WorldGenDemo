/**
 * Given a body position B in world space and a SurfaceProvider, find the
 * UV where the body is exactly R away from the surface along the local
 * outward normal — i.e., the "true tangent foot" of a disc of radius R
 * centered at B and resting on the surface.
 *
 * Used by `surfaceConstrainedVelocity`'s Variant A path to enforce the
 * tangency invariant exactly:
 *
 *     body = sample(uv).position + R · sample(uv).normal
 *
 * The UV-led integration alone is a semi-implicit Euler approximation
 * that drifts off true tangency in high-curvature regions (when the
 * surface frame rotates faster than `dt · curvature` allows). This
 * solver Newton-iterates from the UV-led initial guess until the
 * residual is below tol.
 *
 * Pure function — no buffer access, no system imports. The
 * SurfaceProvider gives the only surface access (sample + worldToUV).
 *
 * Algorithm: residual r(uv) = sample(uv).position + R · sample(uv).normal − B.
 * Newton: uv_{k+1} = uv_k − J^+ · r(uv_k), where J = ∂r/∂uv and J^+ is the
 * pseudoinverse (since r is 3D and uv is 2D). For a stable solution near
 * the initial guess, two iterations are typically enough on the bilinear
 * heightmap. Bail out early once |r| < tol.
 */
import type { SurfaceProvider, SurfaceSample } from "./surfaceProvider";

export interface FootSolveResult {
  /** UV where sample + R·N is closest to body. */
  uv: [number, number];
  /** Sample at the converged UV (same as `surface.sampleAtUV(uv[0], uv[1])`).
   *  Returned so the caller doesn't need to re-sample. */
  sample: SurfaceSample;
  /** Number of Newton iterations performed (1 = converged on first eval). */
  iters: number;
  /** Final residual magnitude (= |sample.position + R·sample.normal − body|). */
  residual: number;
}

/**
 * Solve for the tangent-foot UV. Returns `null` if the solve diverged
 * (residual grew between iterations) or hit maxIter without converging
 * — caller should fall back to the initial guess in that case.
 */
export function findTangentFootUV(
  surface: SurfaceProvider,
  bodyX: number,
  bodyY: number,
  bodyZ: number,
  hintU: number,
  hintV: number,
  R: number,
  maxIter: number = 4,
  tol: number = 1e-5,
): FootSolveResult | null {
  let u = hintU;
  let v = hintV;
  let sample = surface.sampleAtUV(clampU(surface, u), clampV(surface, v));
  let residual = computeResidual(sample, R, bodyX, bodyY, bodyZ);
  let resMag = Math.hypot(residual[0], residual[1], residual[2]);
  if (resMag < tol) {
    return { uv: [u, v], sample, iters: 1, residual: resMag };
  }
  for (let iter = 1; iter <= maxIter; iter++) {
    // Numerically estimate ∂(sample + R·N)/∂u and ∂/∂v via central differences.
    // Step size = one cell-spacing in UV for stable derivatives.
    const eps = 0.5 / Math.max(1, getMaxDim(surface));
    const sUp = surface.sampleAtUV(clampU(surface, u + eps), clampV(surface, v));
    const sUm = surface.sampleAtUV(clampU(surface, u - eps), clampV(surface, v));
    const sVp = surface.sampleAtUV(clampU(surface, u), clampV(surface, v + eps));
    const sVm = surface.sampleAtUV(clampU(surface, u), clampV(surface, v - eps));
    const inv2eps = 1 / (2 * eps);
    const dU0 = (sUp.position[0] + R * sUp.normal[0] - sUm.position[0] - R * sUm.normal[0]) * inv2eps;
    const dU1 = (sUp.position[1] + R * sUp.normal[1] - sUm.position[1] - R * sUm.normal[1]) * inv2eps;
    const dU2 = (sUp.position[2] + R * sUp.normal[2] - sUm.position[2] - R * sUm.normal[2]) * inv2eps;
    const dV0 = (sVp.position[0] + R * sVp.normal[0] - sVm.position[0] - R * sVm.normal[0]) * inv2eps;
    const dV1 = (sVp.position[1] + R * sVp.normal[1] - sVm.position[1] - R * sVm.normal[1]) * inv2eps;
    const dV2 = (sVp.position[2] + R * sVp.normal[2] - sVm.position[2] - R * sVm.normal[2]) * inv2eps;
    const a = dU0 * dU0 + dU1 * dU1 + dU2 * dU2;
    const b = dU0 * dV0 + dU1 * dV1 + dU2 * dV2;
    const c = dV0 * dV0 + dV1 * dV1 + dV2 * dV2;
    const det = a * c - b * b;
    if (Math.abs(det) < 1e-12) return null;
    const rtU = -(dU0 * residual[0] + dU1 * residual[1] + dU2 * residual[2]);
    const rtV = -(dV0 * residual[0] + dV1 * residual[1] + dV2 * residual[2]);
    let dU = (c * rtU - b * rtV) / det;
    let dV = (-b * rtU + a * rtV) / det;
    // Backtracking line search: try full Newton step, fall back to halves if
    // residual grows. Bounded to 4 halving attempts so cost stays linear.
    let damping = 1.0;
    let nextU = u + dU * damping;
    let nextV = v + dV * damping;
    let nextSample = surface.sampleAtUV(clampU(surface, nextU), clampV(surface, nextV));
    let nextResidual = computeResidual(nextSample, R, bodyX, bodyY, bodyZ);
    let nextMag = Math.hypot(nextResidual[0], nextResidual[1], nextResidual[2]);
    let halvings = 0;
    while (nextMag > resMag && halvings < 4) {
      damping *= 0.5;
      nextU = u + dU * damping;
      nextV = v + dV * damping;
      nextSample = surface.sampleAtUV(clampU(surface, nextU), clampV(surface, nextV));
      nextResidual = computeResidual(nextSample, R, bodyX, bodyY, bodyZ);
      nextMag = Math.hypot(nextResidual[0], nextResidual[1], nextResidual[2]);
      halvings++;
    }
    u = nextU;
    v = nextV;
    sample = nextSample;
    residual = nextResidual;
    resMag = nextMag;
    if (resMag < tol) {
      return { uv: [u, v], sample, iters: iter + 1, residual: resMag };
    }
  }
  return { uv: [u, v], sample, iters: maxIter + 1, residual: resMag };
}

function computeResidual(
  sample: SurfaceSample,
  R: number,
  bodyX: number,
  bodyY: number,
  bodyZ: number,
): [number, number, number] {
  return [
    sample.position[0] + R * sample.normal[0] - bodyX,
    sample.position[1] + R * sample.normal[1] - bodyY,
    sample.position[2] + R * sample.normal[2] - bodyZ,
  ];
}

function clampU(surface: SurfaceProvider, u: number): number {
  return surface.wrapsU() ? ((u % 1) + 1) % 1 : Math.max(0, Math.min(1, u));
}

function clampV(surface: SurfaceProvider, v: number): number {
  return surface.wrapsV() ? ((v % 1) + 1) % 1 : Math.max(0, Math.min(1, v));
}

function getMaxDim(surface: SurfaceProvider): number {
  // Heightmap providers know their grid resolution; for other providers
  // assume unit. The eps step is for numerical derivatives only — not
  // critical to pick exactly.
  const anyS = surface as unknown as { heightmap?: { width: number; height: number } };
  if (anyS.heightmap) return Math.max(anyS.heightmap.width, anyS.heightmap.height);
  return 64;
}
