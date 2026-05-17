/**
 * Gravity volumes — scene-author-declared regions of space that override the
 * universal default gravity. Each volume has a shape (sphere / cylinder /
 * AABB), a gravity field (constant vector or radial-to/from-axis), and a
 * priority. ForceField walks volumes in descending priority each tick; the
 * highest-priority containing volume's field is applied to the entity.
 *
 * Pure functions only — no runtime, no Three.js. Tests in
 * `tests/lib/math/gravityVolume.test.ts`.
 *
 * Why volumes rather than per-scene overrides: universal gravity is global,
 * but scenes can carve local exceptions (a "planet" of radial gravity, a
 * low-G zone, a centrifuge interior). The character controller treats every
 * gravity vector as just an external acceleration — no special-case code per
 * scene. See `wiki/worldgen-demo-gravity-volume-design.md`.
 */

import type { Vec3 } from "./quat";
import { addScaled, dot, scale, sub } from "./vec3";

export type GravityField =
  | { type: "constant"; vector: Vec3 }
  | {
      // Radial-to-/from-axis: gravity perpendicular to an infinite line. Cylinder
      // worlds — outside-the-cylinder play uses "toward" so gravity pulls onto
      // the surface; inside-the-cylinder (centrifuge feel) uses "away".
      type: "radial";
      axisOrigin: Vec3;
      axisDirection: Vec3; // expected unit-normalized by caller
      direction: "toward" | "away";
      magnitude: number; // m/s²
    }
  | {
      // Point-radial: gravity toward/from a single world point. Mario-Galaxy-
      // style sphere worlds use "toward center" so the player can walk anywhere
      // on the sphere with gravity always pulling them down onto its surface.
      type: "point";
      center: Vec3;
      direction: "toward" | "away";
      magnitude: number; // m/s²
    }
  | {
      // Toroidal-spine: gravity toward the nearest point on a major-radius
      // circle in the plane perpendicular to `axisDirection` at `axisOrigin`.
      // Torus worlds use "toward" so the player on the torus surface is pulled
      // onto the tube. On-axis (degenerate radial) is a discontinuity — caller
      // should keep the player off the axis.
      type: "circle";
      axisOrigin: Vec3;
      axisDirection: Vec3; // unit; normal to the major-radius plane
      majorRadius: number;
      direction: "toward" | "away";
      magnitude: number; // m/s²
    };

export type GravityVolumeShape =
  | { type: "sphere"; center: Vec3; radius: number }
  | {
      type: "cylinder";
      axisOrigin: Vec3;
      axisDirection: Vec3; // unit
      radius: number;
      halfHeight: number; // along axis from origin in both directions
    }
  | { type: "aabb"; min: Vec3; max: Vec3 };

export interface GravityVolume {
  shape: GravityVolumeShape;
  field: GravityField;
  /** Higher overrides lower; first match wins. Default 0 if not specified. */
  priority: number;
}

/** True if world point p is inside the volume's shape (boundary inclusive). */
export function pointInVolume(shape: GravityVolumeShape, p: Vec3): boolean {
  switch (shape.type) {
    case "sphere": {
      const dx = p[0] - shape.center[0];
      const dy = p[1] - shape.center[1];
      const dz = p[2] - shape.center[2];
      return dx * dx + dy * dy + dz * dz <= shape.radius * shape.radius;
    }
    case "cylinder": {
      const offset: Vec3 = sub(p, shape.axisOrigin);
      const along = dot(offset, shape.axisDirection);
      if (along > shape.halfHeight || along < -shape.halfHeight) return false;
      const radial: Vec3 = sub(offset, scale(shape.axisDirection, along));
      const r2 = dot(radial, radial);
      return r2 <= shape.radius * shape.radius;
    }
    case "aabb":
      return (
        p[0] >= shape.min[0] &&
        p[0] <= shape.max[0] &&
        p[1] >= shape.min[1] &&
        p[1] <= shape.max[1] &&
        p[2] >= shape.min[2] &&
        p[2] <= shape.max[2]
      );
  }
}

/** Gravity vector produced by the field at world point p (m/s²). */
export function evaluateGravityField(field: GravityField, p: Vec3): Vec3 {
  switch (field.type) {
    case "constant":
      return [field.vector[0], field.vector[1], field.vector[2]];
    case "radial": {
      // Project p onto the axis, take perpendicular component → radial offset.
      // Normalize and scale by ±magnitude per direction (toward = into axis = -radial).
      const offset: Vec3 = sub(p, field.axisOrigin);
      const along = dot(offset, field.axisDirection);
      const radial: Vec3 = sub(offset, scale(field.axisDirection, along));
      const r = Math.hypot(radial[0], radial[1], radial[2]);
      if (r < 1e-9) return [0, 0, 0]; // exactly on the axis — no defined radial direction
      const sign = field.direction === "toward" ? -1 : 1;
      const s = (sign * field.magnitude) / r;
      return [radial[0] * s, radial[1] * s, radial[2] * s];
    }
    case "point": {
      // Sphere worlds: gravity toward/from a single point in space.
      const dx = p[0] - field.center[0];
      const dy = p[1] - field.center[1];
      const dz = p[2] - field.center[2];
      const r = Math.hypot(dx, dy, dz);
      if (r < 1e-9) return [0, 0, 0]; // exactly at the centre — no defined direction
      const sign = field.direction === "toward" ? -1 : 1;
      const s = (sign * field.magnitude) / r;
      return [dx * s, dy * s, dz * s];
    }
    case "circle": {
      // Torus worlds: gravity toward the nearest point on a circle of radius
      // `majorRadius` lying in the plane through `axisOrigin` perpendicular to
      // `axisDirection`.
      //
      // 1. Project p onto the major-radius plane (subtract the axis component).
      // 2. From the axis, walk `majorRadius` in the planar direction of p → that
      //    is the nearest point on the spine.
      // 3. Gravity vector points from p toward (or away from) that nearest
      //    point, scaled by magnitude.
      const offset: Vec3 = sub(p, field.axisOrigin);
      const along = dot(offset, field.axisDirection);
      const radial: Vec3 = sub(offset, scale(field.axisDirection, along));
      const r = Math.hypot(radial[0], radial[1], radial[2]);
      if (r < 1e-9) return [0, 0, 0]; // on the axis — radial direction undefined
      // Nearest spine point = axisOrigin + (majorRadius / r) · radial
      const spineX = field.axisOrigin[0] + (radial[0] * field.majorRadius) / r;
      const spineY = field.axisOrigin[1] + (radial[1] * field.majorRadius) / r;
      const spineZ = field.axisOrigin[2] + (radial[2] * field.majorRadius) / r;
      const dx = p[0] - spineX;
      const dy = p[1] - spineY;
      const dz = p[2] - spineZ;
      const d = Math.hypot(dx, dy, dz);
      if (d < 1e-9) return [0, 0, 0]; // exactly on the spine
      const sign = field.direction === "toward" ? -1 : 1;
      const s = (sign * field.magnitude) / d;
      return [dx * s, dy * s, dz * s];
    }
  }
}

/**
 * Pick the gravity vector for an entity at world point p, given a list of
 * candidate volumes and a universal default. Walks volumes in descending
 * priority; the first matching one wins. Outside all volumes → universal.
 *
 * Stateless: caller passes a sorted-by-priority array (use `sortVolumesByPriority`).
 */
export function pickGravity(
  volumes: GravityVolume[],
  universal: Vec3,
  p: Vec3,
): Vec3 {
  for (const v of volumes) {
    if (pointInVolume(v.shape, p)) {
      return evaluateGravityField(v.field, p);
    }
  }
  return [universal[0], universal[1], universal[2]];
}

/** Returns a new array sorted by descending priority. Stable for ties. */
export function sortVolumesByPriority(volumes: GravityVolume[]): GravityVolume[] {
  return [...volumes].sort((a, b) => b.priority - a.priority);
}

// Re-export the helpers the implementation uses so callers don't need to know
// they live in vec3.ts (keeps the API surface clean for consumers of this module).
export { addScaled };
