/**
 * Pure quaternion helpers for buffer-side bone math.
 *
 * Why three.js-free: `src/lib/` is runtime-agnostic per src/lib/CLAUDE.md and
 * cannot import three. Bone transforms live in buffers as plain `[x,y,z,w]`
 * arrays; conversion to `THREE.Quaternion` happens only at the render boundary.
 *
 * Quaternion convention: Hamilton, `[x, y, z, w]`, world-axis composition
 * `world = parent * local` (parent rotation applied on the left).
 */

export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

export function identity(): Quat {
  return [0, 0, 0, 1];
}

/** Quaternion from a yaw rotation about world +Y. */
export function fromYaw(rad: number): Quat {
  const h = rad * 0.5;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

/** `out = a * b` (Hamilton product; applies `b` first, then `a`). */
export function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * Exponential map: axis-angle rotation vector → unit quaternion.
 *
 * `rv` is `axis * angle` (magnitude = angle in radians, direction = axis).
 * Used for compactly storing small per-tick rotation deltas (lean offsets,
 * spring state). Spring integrators are then linear in `rv` and a single
 * conversion happens at the rendering edge.
 */
export function fromRotationVector(rv: Vec3): Quat {
  const angle = Math.hypot(rv[0], rv[1], rv[2]);
  if (angle < 1e-9) return [0, 0, 0, 1];
  const h = angle * 0.5;
  const s = Math.sin(h) / angle;
  return [rv[0] * s, rv[1] * s, rv[2] * s, Math.cos(h)];
}

/** Rotate a 3-vector by a unit quaternion. `v' = q * v * q^-1` expanded. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + qw * t + cross(q.xyz, t)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}
