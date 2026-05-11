/**
 * Inverse-kinematics helpers. Pure math, runtime-agnostic; bone math stays
 * three.js-free per src/lib/CLAUDE.md.
 *
 * Convention: callers pre-transform inputs into a single coordinate frame
 * (typically the upper bone's parent frame, e.g. pelvis-local for legs).
 * Returned rotations are in that same frame:
 *   - `upper` is the rotation to apply to the upper bone relative to its parent.
 *   - `lower` is the rotation to apply to the lower bone relative to the upper.
 * The caller writes these directly into `BoneState.localRot`.
 */

import { type Quat, type Vec3, mul, rotate } from "./quat";

// ---- small vector helpers (kept here to avoid polluting quat.ts) -----------

function vsub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vlen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function vnormOr(v: Vec3, fallback: Vec3): Vec3 {
  const len = vlen(v);
  if (len < 1e-9) return fallback;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function vcross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

// ---- quaternion utilities specific to IK ----------------------------------

/** Conjugate (= inverse for unit quaternions). */
export function quatInv(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/**
 * Shortest-arc quaternion taking unit vector `a` to unit vector `b`.
 * Returns identity when a≈b and a 180°-about-a-perpendicular when a≈-b.
 */
export function quatFromTo(a: Vec3, b: Vec3): Quat {
  const d = vdot(a, b);
  if (d > 0.9999999) return [0, 0, 0, 1];
  if (d < -0.9999999) {
    const fallbackAxis: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const perp = vnormOr(vcross(fallbackAxis, a), [0, 1, 0]);
    return [perp[0], perp[1], perp[2], 0];
  }
  const c = vcross(a, b);
  const w = 1 + d;
  const invLen = 1 / Math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2] + w * w);
  return [c[0] * invLen, c[1] * invLen, c[2] * invLen, w * invLen];
}

// ---- two-bone IK -----------------------------------------------------------

export interface TwoBoneIKResult {
  /** Rotation to apply to the upper bone relative to its parent. */
  upper: Quat;
  /** Rotation to apply to the lower bone relative to the upper bone. */
  lower: Quat;
  /** World/parent-frame position of the mid joint (e.g. knee). */
  midJoint: Vec3;
  /** True if the chain was fully extended (target out of reach, D ≥ L1+L2). */
  overReached: boolean;
}

/**
 * Solve a two-bone chain analytically. All inputs/outputs are expressed in
 * the upper bone's parent frame.
 *
 * @param root - Upper joint position (e.g. hip).
 * @param target - Desired end-effector position (e.g. foot).
 * @param poleDir - Direction the mid joint should bend toward (e.g. forward
 *   for a knee). Must not be near-parallel to (target - root). Doesn't need to
 *   be unit length.
 * @param L1 - Upper bone length.
 * @param L2 - Lower bone length.
 * @param restDir - Direction the chain points to in its bind pose (unit). For
 *   a leg hanging straight down this is `[0, -1, 0]`.
 *
 * When `D = |target - root|` exceeds `L1 + L2` the chain straightens toward
 * the target; when below `|L1 - L2|` it folds at the closer limit. Either is a
 * clamped-but-finite output, not an error.
 */
export function twoBoneIK(
  root: Vec3,
  target: Vec3,
  poleDir: Vec3,
  L1: number,
  L2: number,
  restDir: Vec3 = [0, -1, 0],
): TwoBoneIKResult {
  const toTarget = vsub(target, root);
  const D = vlen(toTarget);
  const dir = vnormOr(toTarget, restDir);

  const sumL = L1 + L2;
  const diffL = Math.abs(L1 - L2);
  const overReached = D >= sumL;
  const Dc = Math.max(diffL + 1e-4, Math.min(sumL - 1e-4, D));

  // Angle at root between (root→target) and (root→mid).
  const cosA = (L1 * L1 + Dc * Dc - L2 * L2) / (2 * L1 * Dc);
  const cosAc = Math.max(-1, Math.min(1, cosA));
  const alpha = Math.acos(cosAc);

  // Build a unit vector orthogonal to `dir` that lies on the same side as
  // poleDir — this is the direction the mid joint protrudes.
  const polePerp = vsub(poleDir, [
    dir[0] * vdot(dir, poleDir),
    dir[1] * vdot(dir, poleDir),
    dir[2] * vdot(dir, poleDir),
  ]);
  const bendDir = vnormOr(
    polePerp,
    // Pole parallel to dir — pick any perpendicular as a fallback so we don't
    // crash on a degenerate input. The mid joint will be wherever; caller
    // should fix the pole.
    Math.abs(dir[1]) < 0.9 ? vcross(dir, [0, 1, 0]) : vcross(dir, [1, 0, 0]),
  );

  const sinA = Math.sin(alpha);
  const cosAA = Math.cos(alpha);
  const midJoint: Vec3 = [
    root[0] + L1 * (cosAA * dir[0] + sinA * bendDir[0]),
    root[1] + L1 * (cosAA * dir[1] + sinA * bendDir[1]),
    root[2] + L1 * (cosAA * dir[2] + sinA * bendDir[2]),
  ];

  // Bone directions in the parent frame.
  const upperWorldDir = vnormOr(vsub(midJoint, root), dir);
  const lowerWorldDir = vnormOr(vsub(target, midJoint), dir);

  // Upper rotation: from rest to upperWorldDir, expressed in parent frame.
  const upper = quatFromTo(restDir, upperWorldDir);

  // Lower rotation: from rest to lowerWorldDir, but expressed in the upper
  // bone's frame (i.e. after applying `upper`). Rotating lowerWorldDir by
  // upper's inverse moves it into the upper bone's local space; then we
  // measure the rotation from rest there.
  const lowerInUpper = rotate(quatInv(upper), lowerWorldDir);
  const lower = quatFromTo(restDir, lowerInUpper);

  return { upper, lower, midJoint, overReached };
}

// Re-export for callers who want the same `mul` they got via quat.ts.
export { mul };
