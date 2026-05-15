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
      type: "radial";
      axisOrigin: Vec3;
      axisDirection: Vec3; // expected unit-normalized by caller
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
