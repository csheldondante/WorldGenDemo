import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";
import type { SurfaceId, SurfaceSample } from "../world/surfaceProvider";

export interface SurfaceAttachmentComponent {
  surfaceId: SurfaceId;
  /** UV coordinates on the surface, in [0, 1]². */
  uv: [number, number];
  /** World-space offset along the surface normal (≥0). */
  offsetAlongNormal: number;
  /** Cached sample at the current UV; refreshed each tick by SurfaceConstraintSystem. */
  sample: SurfaceSample | null;
  /**
   * Counter incremented when the corner-jump iterative loop in
   * surfaceConstrainedVelocity hits its MAX_ITERATIONS cap in a single
   * tick. Hitting the cap isn't necessarily a bug — it can mean a
   * fast-moving disc crossed many segments — but is unusual enough to
   * warrant human review. Persisted in baselines so scenarios that
   * legitimately exercise the cap can lock in their expected count and
   * future runs flag any deviation. Treated as 0 when undefined; should
   * stay 0 for all normal-play scenarios.
   */
  cornerJumpIterationCapHits?: number;
  /**
   * Body's world-space offset FROM the contact point (= body = sample.position
   * + contactOffset). Per-entity buffer state that interpolates each tick
   * toward a "desired" lean direction = blend(surface_normal, gravity_up,
   * speed/maxSpeed) — at rest, gravity dominates (weight stacked above the
   * feet); at full speed, surface normal dominates (lean into the
   * surface). When the corner-jump CCD transitions contact discretely
   * (= disc rolls off one segment onto another), this offset is RESET to
   * preserve body position across the transition; subsequent ticks
   * interpolate it back toward the desired blend. This decouples body
   * position from the surface-normal swing at triangle boundaries, which
   * fixed the off-angle teleport bug (2026-05-23).
   *
   * Default at spawn: (0, R, 0). Treated as (0, R, 0) when undefined for
   * back-compat with scenarios that haven't initialized it.
   */
  contactOffset?: [number, number, number];
}

export interface SurfaceAttachmentBufferData {
  byEntity: Map<EntityId, SurfaceAttachmentComponent>;
}

export const SURFACE_ATTACHMENT_BUFFER_ID = "surfaceAttachment";

export function createSurfaceAttachmentBuffer(): Buffer<SurfaceAttachmentBufferData> {
  return createBuffer<SurfaceAttachmentBufferData>({
    id: SURFACE_ATTACHMENT_BUFFER_ID,
    description:
      "Per-entity surface-constraint state: which surface, UV on it, offset along normal, cached sample. Maintained by SurfaceConstraintSystem when CharacterController.locomotionMode is surfaceConstrained.",
    initial: { byEntity: new Map() },
  });
}
