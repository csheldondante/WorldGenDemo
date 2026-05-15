/**
 * 3-vector helpers, runtime-agnostic per `src/lib/CLAUDE.md` (no `three`).
 *
 * Vectors are plain `[x, y, z]` arrays (see `quat.ts` for the `Vec3` type).
 * Functions return new arrays — no in-place mutation. Allocate at module
 * boundaries; tight inner loops can still inline the math when profiling
 * demands it.
 */

import type { Vec3 } from "./quat";

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function lengthSq(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/**
 * Returns the unit-length vector along `a`. Returns `[0,0,0]` if `a` is
 * effectively zero (length < 1e-12). Callers that need a different fallback
 * should check `length(a)` themselves.
 */
export function normalize(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2]);
  if (len < 1e-12) return [0, 0, 0];
  const inv = 1 / len;
  return [a[0] * inv, a[1] * inv, a[2] * inv];
}

/** `a + s·b` — common in integration steps. */
export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

/**
 * Two orthonormal vectors spanning the plane perpendicular to `axis`. Useful
 * for parameterizing cylinders/tori where we need consistent "perpA, perpB"
 * basis vectors given only the axis direction.
 *
 * Convention: `perpA` is as close to world +Y as possible (or world +X if axis
 * is nearly ±Y); `perpB = cross(axis, perpA)`. This makes "u = 0" on a
 * horizontal-axis cylinder point world-up, which matches the "running on top of
 * a log" intuition for gym scenes.
 */
export function basisPerpendicular(axis: Vec3): { perpA: Vec3; perpB: Vec3 } {
  const a = normalize(axis);
  // Reference up = world +Y, unless axis is nearly ±Y in which case use +X
  const ref: Vec3 = Math.abs(a[1]) > 0.999 ? [1, 0, 0] : [0, 1, 0];
  // perpA = component of `ref` perpendicular to `a`, normalized
  const refDotA = dot(ref, a);
  const perpA = normalize([
    ref[0] - refDotA * a[0],
    ref[1] - refDotA * a[1],
    ref[2] - refDotA * a[2],
  ]);
  const perpB = cross(a, perpA); // unit since both inputs are unit and orthogonal
  return { perpA, perpB };
}
