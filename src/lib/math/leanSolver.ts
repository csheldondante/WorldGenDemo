/**
 * Inverted-pendulum lean solver. Pure math, runtime-agnostic.
 *
 * Given the character's velocity, real acceleration, surface normal under
 * the feet, world gravity, and a drag coefficient, returns the world-space
 * "body up" direction the character should align with so the implied
 * ground-reaction force is physically plausible — i.e., the body is
 * "balanced" as an inverted pendulum on the support surface.
 *
 * Math (per procedural_physical_locomotion_handoff.md):
 *
 *   a_eff       = a_real + dragCoeff · v            // implicit drag → steady-state lean
 *   a_tangent   = a_eff − dot(a_eff, N) · N         // project to support tangent plane
 *   apparentG   = gravity − a_tangent               // what the body must "fall along"
 *   bodyUp      = −normalize(apparentG)             // target up direction (world)
 *
 * For a body trying to produce acceleration `a` while balanced on a foot,
 * the only horizontal force comes from gravity's projection through the
 * tilted body axis. Solving for the lean that makes this work yields the
 * apparent-gravity formulation above. It handles slopes cleanly because the
 * tangent projection uses the local surface normal, not world up.
 */

import type { Vec3 } from "./quat";

const EPS = 1e-9;

function vsub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vlen(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function vdot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vscale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

function vadd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vnormalize(v: Vec3, fallback: Vec3): Vec3 {
  const len = vlen(v);
  if (len < EPS) return [fallback[0], fallback[1], fallback[2]];
  return [v[0] / len, v[1] / len, v[2] / len];
}

export interface SolveBodyUpInputs {
  /** World linear velocity (m/s). Y component is used for slope projection. */
  velocity: Vec3;
  /** World linear acceleration this tick (m/s²). Y component included; gravity is the reference, not the accel itself. */
  accelReal: Vec3;
  /** Unit normal of the support surface (or world up if airborne / no contact). */
  surfaceNormal: Vec3;
  /** World gravity vector (m/s²). Typically (0, -g, 0). */
  gravity: Vec3;
  /** Implicit drag (1/s). Steady-state lean at velocity v: atan(dragCoeff·v / g). 0 = lean only on actual accel. */
  dragCoeff: number;
  /**
   * 0..1. How much of the static gravity-along-slope component the body
   * "implicitly" accounts for via lean. At 1.0, the body leans uphill on a
   * slope as if it were producing the force needed to stay there — captures
   * the visible-force-balance the actual character controller does in
   * physics but doesn't expose to the anim layer. On flat ground this term
   * vanishes (gravity-along-tangent = 0). Default 1.0.
   */
  gravityCounterScale?: number;
}

export interface SolveBodyUpResult {
  /** Unit vector in world frame — direction the body's local +Y should point. */
  bodyUpTarget: Vec3;
  /** Tangential effective acceleration vector (for debug overlay + compression). */
  tangentAccel: Vec3;
  /** Apparent gravity vector (gravity − tangentAccel) — magnitude is the "effective g" felt by the body. */
  apparentGravity: Vec3;
  /** Lean angle from surface normal (radians). atan2(|tangentAccel|, |gravityPerp|). */
  leanAngle: number;
}

/**
 * Compute the target body-up direction and intermediate vectors for debug.
 * Falls back to surface normal (or world up if normal is degenerate) when
 * effective gravity is too small to determine a direction.
 */
export function solveBodyUpTarget(inputs: SolveBodyUpInputs): SolveBodyUpResult {
  const { velocity, accelReal, surfaceNormal, gravity, dragCoeff } = inputs;
  const gravityCounterScale = inputs.gravityCounterScale ?? 1.0;
  const N = vnormalize(surfaceNormal, [0, 1, 0]);

  // a_eff = a_real + dragCoeff · v + gravityCounterScale · (−gravity_tangent).
  // The third term lets the body lean as if it were producing the force
  // needed to overcome gravity-along-slope. On flat ground gravity_tangent
  // = 0 so this vanishes; on a 30° slope it adds ~5 m/s² uphill, tipping
  // the body further into the hill (which is what real climbers do).
  const gDotN = vdot(gravity, N);
  const gravityTangent = vsub(gravity, vscale(N, gDotN));
  const climbCounter = vscale(gravityTangent, -gravityCounterScale);
  const aEff = vadd(vadd(accelReal, vscale(velocity, dragCoeff)), climbCounter);

  // Project a_eff into the tangent plane defined by N: a_tangent = a − (a·N)N.
  const aDotN = vdot(aEff, N);
  const tangentAccel = vsub(aEff, vscale(N, aDotN));

  // apparentGravity = gravity − tangentAccel. The body must orient so its
  // local +Y points along −apparentGravity (so gravity projected through the
  // tilted body provides the tangential force needed for a_tangent).
  const apparentGravity = vsub(gravity, tangentAccel);
  const bodyUpTarget = vnormalize(vscale(apparentGravity, -1), N);

  // Lean angle: the angle between the surface normal N and the body up
  // target. atan2 of the tangent-plane magnitude vs the normal-axis magnitude
  // of (−apparentGravity).
  const minusG = vscale(apparentGravity, -1);
  const minusGDotN = vdot(minusG, N);
  const minusGTangentComp = vsub(minusG, vscale(N, minusGDotN));
  const leanAngle = Math.atan2(vlen(minusGTangentComp), minusGDotN);

  return { bodyUpTarget, tangentAccel, apparentGravity, leanAngle };
}
