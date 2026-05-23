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

/**
 * Joystick-basis intent projection. Maps the player's stick input through
 * the camera basis as:
 *
 *     intent_world = moveY · camera_up + moveX · camera_right
 *     intent_tangent = intent_world projected onto tangent plane
 *
 * `camera_up` here is the camera's ACTUAL world-Y axis (= upHint
 * perpendicularized against F, then normalized) — NOT `upHint`/`pivot.up`
 * directly. The distinction is load-bearing: for a third-person camera
 * looking slightly downward at the player, camera-up has a small +F
 * (forward) component, so its tangent projection points in the
 * camera-forward XZ direction even when N is near-vertical (hilltop,
 * crest). Using `upHint` directly here would project (0,1,0) onto a tilted
 * N → up-the-slope direction, which flips sign as the foot crosses a
 * crest line and causes oscillation. See
 * `wiki/worldgen-demo-camera-up-pivot-vs-world-y.md` (2026-05-18) for the
 * earlier instance of this same trap.
 *
 * Camera-right is computed as F × camera_up — the camera's actual world
 * X axis. Both basis vectors are projected INDEPENDENTLY onto the tangent
 * plane (camera-right has no fallback per design).
 *
 * Fallback: when `camera_up`'s tangent projection is degenerate (= U ‖ N,
 * i.e. camera looking straight along the surface normal — very rare), the
 * forward axis falls back to F's projection. Per user 2026-05-20 memory:
 * `worldgen-demo-disc-collider-and-intent-basis-2026-05-20.md`.
 *
 * Inputs F (camera lookDir) and upHint (lookAt up-hint, typically
 * `pivot.up` / local gravity-up) are assumed unit-length; N is the
 * surface normal at the contact, unit-length.
 */
export function projectCameraIntentBasis(
  F: Vec3,
  upHint: Vec3,
  N: Vec3,
): CameraTangentBasis {
  // Derive camera's actual world-Y axis = upHint perpendicularized against
  // F, then normalized. Identical construction to projectCameraTangentForward
  // — see this file's header for why pivot.up alone is wrong.
  const FdotUp = F[0] * upHint[0] + F[1] * upHint[1] + F[2] * upHint[2];
  let UyX = upHint[0] - FdotUp * F[0];
  let UyY = upHint[1] - FdotUp * F[1];
  let UyZ = upHint[2] - FdotUp * F[2];
  const UyLen = Math.hypot(UyX, UyY, UyZ);
  // Gimbal: F ‖ upHint (camera staring straight along gravity-up). The
  // pitch cushion prevents this in practice; if it does happen, fall back
  // to projecting F.
  const gimbal = UyLen < EPS;
  if (!gimbal) {
    UyX /= UyLen; UyY /= UyLen; UyZ /= UyLen;
  }

  // Forward direction = intersection of the camera-ZY plane (spanned by F
  // and U_cam) with the tangent plane (perpendicular to N). Two planes
  // meet in a LINE; that line lies in BOTH planes by construction, so
  // the body's forward motion is automatically in the camera-ZY plane
  // (= no lateral drift relative to the camera) AND on the surface (=
  // in the tangent plane).
  //
  // The intersection direction is perpendicular to both plane normals:
  //   forward ∝ (camera_right) × N    where camera_right = F × U_cam
  // Sign is chosen so forward · F > 0 (= matches camera-look direction).
  //
  // Per user 2026-05-23: the earlier "project U onto tangent" formulation
  // dropped F·N into the projected vector, leaving a lateral component
  // perpendicular to camera-ZY. The intersection formulation eliminates
  // that lateral leakage by construction.
  let cRightX: number, cRightY: number, cRightZ: number;
  if (!gimbal) {
    cRightX = F[1] * UyZ - F[2] * UyY;
    cRightY = F[2] * UyX - F[0] * UyZ;
    cRightZ = F[0] * UyY - F[1] * UyX;
  } else {
    cRightX = 0; cRightY = 0; cRightZ = 0;
  }
  // forward = camera_right × N.
  let fwdX = cRightY * N[2] - cRightZ * N[1];
  let fwdY = cRightZ * N[0] - cRightX * N[2];
  let fwdZ = cRightX * N[1] - cRightY * N[0];
  // Sign: align with F so "press W" goes where the camera looks.
  const fwdDotF = fwdX * F[0] + fwdY * F[1] + fwdZ * F[2];
  if (fwdDotF < 0) { fwdX = -fwdX; fwdY = -fwdY; fwdZ = -fwdZ; }
  let fwdLen = Math.hypot(fwdX, fwdY, fwdZ);
  if (fwdLen < EPS) {
    // Camera-right ‖ N (= camera-ZY plane parallel to tangent plane), or
    // gimbal lock. Fall back to F projected onto tangent.
    const fDotN = F[0] * N[0] + F[1] * N[1] + F[2] * N[2];
    fwdX = F[0] - fDotN * N[0];
    fwdY = F[1] - fDotN * N[1];
    fwdZ = F[2] - fDotN * N[2];
    fwdLen = Math.hypot(fwdX, fwdY, fwdZ);
    if (fwdLen < EPS) return { forward: null, right: null };
  }
  fwdX /= fwdLen; fwdY /= fwdLen; fwdZ /= fwdLen;

  // Right axis = camera-right projected onto tangent plane (= the line in
  // the tangent plane perpendicular to camera-ZY).
  if (gimbal) {
    // F ‖ upHint — camera-right undefined. Synthesize from forward × N.
    cRightX = fwdY * N[2] - fwdZ * N[1];
    cRightY = fwdZ * N[0] - fwdX * N[2];
    cRightZ = fwdX * N[1] - fwdY * N[0];
  }
  const rDotN = cRightX * N[0] + cRightY * N[1] + cRightZ * N[2];
  let rightX = cRightX - rDotN * N[0];
  let rightY = cRightY - rDotN * N[1];
  let rightZ = cRightZ - rDotN * N[2];
  const rightLen = Math.hypot(rightX, rightY, rightZ);
  if (rightLen < EPS) return { forward: null, right: null };
  rightX /= rightLen; rightY /= rightLen; rightZ /= rightLen;

  return {
    forward: [fwdX, fwdY, fwdZ],
    right: [rightX, rightY, rightZ],
  };
}
