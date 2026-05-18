import { describe, it, expect } from "vitest";
import { projectCameraTangentForward } from "../../../src/lib/math/cameraTangent";
import type { Vec3 } from "../../../src/lib/math/quat";

const unit = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
};

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function expectVec3Close(actual: Vec3, expected: Vec3, decimals = 6) {
  expect(actual[0]).toBeCloseTo(expected[0], decimals);
  expect(actual[1]).toBeCloseTo(expected[1], decimals);
  expect(actual[2]).toBeCloseTo(expected[2], decimals);
}

describe("projectCameraTangentForward", () => {
  it("flat ground, behind-player camera below 45° → projects F", () => {
    // Camera looking forward and 30° down. upHint = world+Y.
    // |F·N| = 0.5, |cameraWorldY · N| = cos(30°) = 0.866 → useF.
    const F = unit([0, -0.5, -0.866]);
    const upHint: Vec3 = [0, 1, 0];
    const N: Vec3 = [0, 1, 0];

    const { forward, right } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    expectVec3Close(forward!, [0, 0, -1]);
    expectVec3Close(right!, [1, 0, 0]);
  });

  it("flat ground, camera nearly straight down → projects camera world Y", () => {
    // F nearly anti-parallel to upHint but not exactly (pitch cushion).
    // cameraWorldY is mostly in the world XZ plane along the forward
    // direction; press W should move there.
    const F = unit([0, -0.99, -0.14]);
    const upHint: Vec3 = [0, 1, 0];
    const N: Vec3 = [0, 1, 0];

    const { forward } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    // Forward should be -Z (screen up after projecting), not noisy.
    expectVec3Close(forward!, [0, 0, -1], 2);
  });

  it("crossover at exactly 45° pitch → both F and cameraWorldY project to same direction", () => {
    const F = unit([0, -Math.sqrt(0.5), -Math.sqrt(0.5)]);
    const upHint: Vec3 = [0, 1, 0];
    const N: Vec3 = [0, 1, 0];

    const { forward } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    expectVec3Close(forward!, [0, 0, -1], 5);
  });

  it("steep slope, camera trailing behind looking nearly along N → cameraWorldY dominates, gives up-slope", () => {
    const N: Vec3 = unit([0, 0.5, 0.866]); // 60° slope tilted toward +Z
    const F: Vec3 = unit([0, -0.5, -0.866]); // looks down-slope from behind
    const upHint: Vec3 = [0, 1, 0];

    const { forward } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    // Up-slope direction projected: (0, +Y, -Z)
    expect(forward![1]).toBeGreaterThan(0);
    expect(forward![2]).toBeLessThan(0);
    // Tangent plane membership.
    expect(Math.abs(dot(forward!, N))).toBeLessThan(1e-6);
  });

  it("vertical wall + elevated camera (upHint = N) → useF; forward = +Z along wall", () => {
    const N: Vec3 = [1, 0, 0];
    const F: Vec3 = unit([-0.5, 0, 0.866]);
    const upHint: Vec3 = [1, 0, 0]; // pivot.up = N on a vertical wall

    const { forward } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    expect(Math.abs(dot(forward!, N))).toBeLessThan(1e-6);
    expectVec3Close(forward!, [0, 0, 1]);
  });

  it("past-zenith: camera ahead of player looking back+down → cameraWorldY's projection sends player away from camera", () => {
    // Camera has swung over the player to in front, looking back at them
    // from below. F has +Z; cameraWorldY's tangent projection should still
    // point along +Z (away from where the player came from, toward the
    // camera) — same world direction the player wants when pressing W.
    const F: Vec3 = unit([0, 0.3, 0.95]);
    const upHint: Vec3 = [0, 1, 0];
    const N: Vec3 = [0, 1, 0];

    const { forward } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    expect(forward![2]).toBeGreaterThan(0);
    expectVec3Close(forward!, [0, 0, 1], 2);
  });

  it("cylinder side spawn (upHint = N) → useF (camera world Y degenerate after projection vs N)", () => {
    // Concave wall: F along the cylinder axis-perpendicular, upHint = N.
    // cameraWorldY ends up in the tangent plane too, with |·N| = 0. Tie
    // with F's |·N| = 0; useF wins by the tie-break.
    const F: Vec3 = [0, 0, -1];
    const upHint: Vec3 = [1, 0, 0]; // pivot.up = -gravity = +X on concave wall at u=0
    const N: Vec3 = [-1, 0, 0];

    const { forward, right } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    expectVec3Close(forward!, [0, 0, -1]);
    expect(right).not.toBeNull();
  });

  it("gimbal lock (F ‖ upHint, F ‖ N) → null", () => {
    const F: Vec3 = [0, 1, 0];
    const upHint: Vec3 = [0, 1, 0];
    const N: Vec3 = [0, 1, 0];
    const { forward, right } = projectCameraTangentForward(F, upHint, N);
    expect(forward).toBeNull();
    expect(right).toBeNull();
  });

  it("gimbal lock (F ‖ upHint) but F ⊥ N → falls back to F projection", () => {
    const F: Vec3 = [0, 0, -1];
    const upHint: Vec3 = [0, 0, -1]; // pathological — upHint should usually be gravity-up
    const N: Vec3 = [0, 1, 0];
    const { forward } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    expectVec3Close(forward!, [0, 0, -1]);
  });

  it("right = forward × N and is unit length", () => {
    const F: Vec3 = unit([0.1, -0.3, -0.95]);
    const upHint: Vec3 = [0, 1, 0];
    const N: Vec3 = [0, 1, 0];
    const { forward, right } = projectCameraTangentForward(F, upHint, N);
    expect(forward).not.toBeNull();
    const rLen = Math.hypot(right![0], right![1], right![2]);
    expect(rLen).toBeCloseTo(1, 6);
    const expectedRight: Vec3 = [
      forward![1] * N[2] - forward![2] * N[1],
      forward![2] * N[0] - forward![0] * N[2],
      forward![0] * N[1] - forward![1] * N[0],
    ];
    expectVec3Close(right!, expectedRight);
  });
});
