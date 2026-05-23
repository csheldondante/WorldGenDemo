import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

/**
 * OPT-IN per-tick diagnostic capture for `surfaceConstrainedVelocitySystem`.
 *
 * Defaults to `enabled: false` — production pays one bool read per
 * surface-attached entity per tick. Tests flip it via
 * `BufferTest.enableDebugBuffers: ["surfaceConstrainedVelocityDebug"]` to
 * make the solver append one `SCVDebugRow` per entity per tick.
 *
 * Captures the values that drive the bilinear-N / corner-jump / drop-normal
 * pipeline so we can see exactly where velocity direction or position
 * jumps come from — without console.logs or module globals (forbidden per
 * `docs/unit_tests.md`).
 */
export interface SCVDebugRow {
  tick: number;
  /** sample.normal AT START OF TICK (= the normal at body's foot UV before
   *  UV advance). */
  nPreX: number;
  nPreY: number;
  nPreZ: number;
  /** sample_new.normal AFTER UV advance (= what drop-normal step 5 uses). */
  nPostX: number;
  nPostY: number;
  nPostZ: number;
  /** Velocity AT START of tick (= end of previous tick's solve). */
  velStartX: number;
  velStartY: number;
  velStartZ: number;
  /** Velocity AFTER step 1 integration (= start vel + accel·dt). */
  velAfterAccelX: number;
  velAfterAccelY: number;
  velAfterAccelZ: number;
  /** Velocity AFTER step 3b corner-jump branch (= same as velAfterAccel
   *  if branch didn't fire). */
  velAfterCornerJumpX: number;
  velAfterCornerJumpY: number;
  velAfterCornerJumpZ: number;
  /** Velocity AFTER step 5 drop-normal (= final vel for this tick). */
  velFinalX: number;
  velFinalY: number;
  velFinalZ: number;
  /** Position AT END of this tick (= disc center = foot + R·N_post). */
  posX: number;
  posY: number;
  posZ: number;
  /** Foot horizontal motion direction (d_h) and magnitude, as the
   *  corner-jump branch saw them. dhx²+dhz² ≈ 1 when hLen ≥ threshold. */
  dhX: number;
  dhZ: number;
  hLen: number;
  /** Did the corner-jump CCD branch fire this tick? */
  cornerJumped: boolean;
  /** Number of corner-jump CCD iterations consumed (0 = no candidate
   *  segments, or first sweep had no hits). */
  cornerJumpIters: number;
  /** Number of profile vertices AFTER collinear-merge (1 + segment count). */
  profileVertCount: number;
  /** Max abs(cross/(l1·l2)) = sin(angle change) across adjacent kept
   *  segments. Indicates the "sharpest" feature in the profile this tick. */
  profileMaxSin: number;
  /** Step-5 drop-normal magnitude (= |vel·N_post|). Direct read of how
   *  much the constraint reaction absorbed this tick. */
  dropMagnitude: number;
}

export interface SurfaceConstrainedVelocityDebugComponent {
  history: SCVDebugRow[];
}

export interface SurfaceConstrainedVelocityDebugBufferData {
  enabled: boolean;
  byEntity: Map<EntityId, SurfaceConstrainedVelocityDebugComponent>;
}

export const SURFACE_CONSTRAINED_VELOCITY_DEBUG_BUFFER_ID =
  "surfaceConstrainedVelocityDebug";

export function createSurfaceConstrainedVelocityDebugBuffer(): Buffer<SurfaceConstrainedVelocityDebugBufferData> {
  return createBuffer<SurfaceConstrainedVelocityDebugBufferData>({
    id: SURFACE_CONSTRAINED_VELOCITY_DEBUG_BUFFER_ID,
    description:
      "OPT-IN per-tick diagnostic for surfaceConstrainedVelocitySystem. Captures normal direction at start vs end of tick, velocity at each step (start / after accel / after corner-jump / final), foot motion direction, corner-jump firing + profile stats, and drop-normal magnitude. Off by default; tests flip enabled via BufferTest.enableDebugBuffers.",
    initial: { enabled: false, byEntity: new Map() },
  });
}
