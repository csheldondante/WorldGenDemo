/**
 * Camera → surface-tangent forward projection.
 *
 * Maps a player's "forward on the stick" intent into a unit world-space
 * direction lying in the surface tangent plane. The intent is the
 * projection of whichever of {camera forward F, camera world-up Y} is
 * more tangent to the surface (smaller magnitude dot product with N).
 *
 * **Important:** the "up" we compare against is the camera's actual
 * world Y axis after `lookAt(pivot, up=upHint)`:
 *
 *     cameraWorldY = normalize(upHint − F·(F·upHint))
 *
 * — i.e. the upHint perpendicularized against F, then renormalized. This
 * is NOT the same as upHint itself, and the distinction matters:
 * `cameraWorldY · N = sin(angle between F and upHint)` by construction,
 * so |cameraWorldY · N| crosses |F · N| at the 45° pitch boundary, which
 * is what makes the rule "below 45° use F, above use camera-up" work
 * regardless of how upHint relates to N. Passing upHint directly (e.g.
 * pivot.up, which equals N on radial-gravity gyms) collapses the
 * comparison to "always use F" and the switch never happens.
 *
 * Rationale by camera pose:
 *  - Behind-the-player camera looking roughly horizontally: |F·N| small,
 *    cameraWorldY mostly along upHint. Project F (legacy behavior).
 *  - Camera tilted past ~45° toward overhead: |F·N| > |cameraWorldY · N|,
 *    so project cameraWorldY — the screen-up direction. Press W ≡ "move
 *    where the screen shows up." Stays well-defined as F approaches N.
 *  - Camera past zenith (player upside-down relative to camera): |F·N|
 *    flips back below |cameraWorldY · N|, so we use F again — sending
 *    the player away from the camera in the opposite world direction.
 *
 * Sign is intrinsic: the chosen reference vector encodes "forward intent"
 * by its own direction (F = look, cameraWorldY = screen up). No extra
 * sign correction needed.
 */

import type { Vec3 } from "./quat";

const EPS = 1e-6;

export interface CameraTangentBasis {
  /**
   * Unit "forward on stick" tangent direction. `null` only when both the
   * chosen reference and the F fallback are parallel to N (a fully
   * degenerate camera/surface relationship). Hold the previous frame's
   * forward in that case.
   */
  forward: Vec3 | null;
  /**
   * `forward × N` — right-handed lateral tangent. `null` iff `forward`
   * is null. Matches the existing tangentInputMapper convention.
   */
  right: Vec3 | null;
}

/**
 * Project the more-tangent of {camera forward F, camera world Y} onto the
 * tangent plane perpendicular to N. `upHint` is the lookAt up-hint
 * (typically `cam.pivot.up`, the local gravity-up); the helper
 * perpendicularizes it against F to recover the camera's actual world Y
 * axis before comparing dot products.
 *
 * Inputs F and N are assumed unit-length; upHint is normalized but need
 * not be perpendicular to F. None are validated.
 */
export function projectCameraTangentForward(
  F: Vec3,
  upHint: Vec3,
  N: Vec3,
): CameraTangentBasis {
  // Derive camera world Y = upHint perpendicularized against F.
  const FdotUp = F[0] * upHint[0] + F[1] * upHint[1] + F[2] * upHint[2];
  let UyX = upHint[0] - FdotUp * F[0];
  let UyY = upHint[1] - FdotUp * F[1];
  let UyZ = upHint[2] - FdotUp * F[2];
  const UyLen = Math.hypot(UyX, UyY, UyZ);
  // Gimbal: F ‖ upHint (camera looking straight along gravity-up — the
  // pitch cushion prevents this in practice). Fall back to projecting F
  // alone; if F is also degenerate vs N, give up.
  const gimbal = UyLen < EPS;
  if (!gimbal) {
    UyX /= UyLen; UyY /= UyLen; UyZ /= UyLen;
  }

  const FdotN = F[0] * N[0] + F[1] * N[1] + F[2] * N[2];
  const UydotN = gimbal ? 1 : UyX * N[0] + UyY * N[1] + UyZ * N[2];

  const useF = gimbal || Math.abs(FdotN) <= Math.abs(UydotN);
  const refX = useF ? F[0] : UyX;
  const refY = useF ? F[1] : UyY;
  const refZ = useF ? F[2] : UyZ;
  const refDotN = useF ? FdotN : UydotN;

  let dirX = refX - refDotN * N[0];
  let dirY = refY - refDotN * N[1];
  let dirZ = refZ - refDotN * N[2];
  const dirLen = Math.hypot(dirX, dirY, dirZ);
  if (dirLen < EPS) return { forward: null, right: null };
  dirX /= dirLen; dirY /= dirLen; dirZ /= dirLen;

  // right = forward × N. Unit since both inputs are unit and orthogonal.
  const rightX = dirY * N[2] - dirZ * N[1];
  const rightY = dirZ * N[0] - dirX * N[2];
  const rightZ = dirX * N[1] - dirY * N[0];

  return {
    forward: [dirX, dirY, dirZ],
    right: [rightX, rightY, rightZ],
  };
}
