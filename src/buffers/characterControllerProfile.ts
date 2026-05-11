import { createBuffer, type Buffer } from "../runtime/buffer";

export type ProfileId = string;

/**
 * Tunable movement parameters for a class of character. All knobs that affect
 * "feel" live here — code reads, never bakes constants. Multiple profiles can
 * coexist (player vs NPC, light/heavy variants); CharacterControllerComponent
 * references one by ID.
 */
export interface CharacterControllerProfile {
  id: ProfileId;
  /** Maximum surface-tangent speed under normal run, m/s. Inputs map to a desired velocity scaled by this. */
  desiredRunSpeed: number;
  /** Max self-applied accel along character +forward (m/s²). Capped further by surface gripBudget. */
  forwardAccelMax: number;
  /** Max self-applied accel along character -forward (m/s²). Typically smaller than forward. */
  backwardAccelMax: number;
  /** Max self-applied accel along character ±right (m/s²). Used for both left and right strafing. */
  lateralAccelMax: number;
  /** Max self-applied accel along surface +normal (m/s²). Boost off the surface. Jump uses impulse instead. */
  upAccelMax: number;
  /** Max self-applied accel along surface -normal (m/s²). Push into the surface. */
  downAccelMax: number;
  /** Multiplier on surface.normalInMax: required normal-in > scale × cap → enter ragdoll. */
  ragdollNormalInScale: number;
  /** Multiplier on surface.normalOutMax: required normal-out > scale × cap → detach to airborne. */
  detachNormalOutScale: number;
  /** Multiplier on grip budget: required tangent force > scale × budget → slip into surfaceSlide. */
  slideGripScale: number;
  /** Aerial control acceleration in volume mode, m/s². Lower than ground for that "committed-to-jump" feel. */
  airAccel: number;
  /** Aerial maximum horizontal speed cap, m/s. */
  airSpeedCap: number;
  /** Vertical impulse applied on a short jump press, m/s. */
  jumpImpulse: number;
  /** Hold-time threshold to upgrade jump → wing launch, seconds. */
  wingLaunchHoldSec: number;
  /** Vertical impulse for a wing launch (longer-hold jump), m/s. */
  wingLaunchImpulse: number;
  /** Vertical+forward impulse for an airborne flap, m/s in each component. */
  flapImpulseUp: number;
  flapImpulseFwd: number;
  /** Multiplier on world gravity while gliding (smaller = floatier). */
  glideGravityMul: number;
  /** Forward acceleration applied while gliding, m/s². */
  glideForwardAccel: number;
  /** Slope steepness (radians) above which surfaceRun → surfaceSlide. */
  slopeRunMaxRad: number;
  /** Slope (radians) below which we can stand again from a slide. */
  slopeStandMaxRad: number;
  /** When integrating an airborne entity, snap to the surface if within this height (m). */
  landingSnapMeters: number;
  /** Player sphere radius, also used for surface offset. */
  bodyRadius: number;

  // --- Orientation / turning -------------------------------------------------
  // Mirrors the linear-motion phases (desired velocity → required accel →
  // capped accel → integrate) but for body yaw. The desired yaw velocity is
  // proportional to the offset between body and target yaw, clamped by
  // `desiredTurnRate`. The applied angular accel is `turnAccelMax` capped.
  // ---------------------------------------------------------------------------
  /** Maximum body-turn rate, rad/s. */
  desiredTurnRate: number;
  /** Maximum body angular acceleration, rad/s². */
  turnAccelMax: number;
  /** P-gain on (target − current) yaw → desired turn rate. Higher = snappier
   *  small-angle response; saturates to `desiredTurnRate` past a threshold. */
  turnPGain: number;
  /**
   * Below this |moveY| threshold (toward backward) the character does NOT
   * rotate to face the movement direction — it keeps facing the camera and
   * the body walks backward. Prevents 180° spins on quick stick reversals.
   */
  walkBackwardYThreshold: number;
}

export interface CharacterControllerProfileBufferData {
  byId: Map<ProfileId, CharacterControllerProfile>;
}

export const CHARACTER_CONTROLLER_PROFILE_BUFFER_ID = "characterControllerProfile";

export const DEFAULT_PLAYER_PROFILE: CharacterControllerProfile = {
  id: "player",
  desiredRunSpeed: 8,
  forwardAccelMax: 40,
  backwardAccelMax: 25,
  lateralAccelMax: 35,
  upAccelMax: 5,
  downAccelMax: 5,
  ragdollNormalInScale: 1.5,
  detachNormalOutScale: 1.0,
  slideGripScale: 1.0,
  airAccel: 12,
  airSpeedCap: 12,
  jumpImpulse: 7,
  wingLaunchHoldSec: 0.35,
  wingLaunchImpulse: 14,
  flapImpulseUp: 5,
  flapImpulseFwd: 3,
  glideGravityMul: 0.25,
  glideForwardAccel: 6,
  slopeRunMaxRad: 0.9,   // ~52 degrees
  slopeStandMaxRad: 0.7, // ~40 degrees
  landingSnapMeters: 0.4,
  bodyRadius: 0.5,
  desiredTurnRate: 6,         // rad/s — ~344°/s; can do a 180° in ~0.55s once at speed.
  turnAccelMax: 40,           // rad/s² — reaches max turn rate in 0.15s.
  turnPGain: 8,               // rad/s per rad offset; saturates to desiredTurnRate at ~0.75 rad (43°).
  walkBackwardYThreshold: -0.3, // moveY < -0.3 → walk backward instead of spinning.
};

export function createCharacterControllerProfileBuffer(): Buffer<CharacterControllerProfileBufferData> {
  const buf = createBuffer<CharacterControllerProfileBufferData>({
    id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
    description:
      "Tunable movement parameters by profile id. Edit values here to retune feel without touching code; multiple profiles can coexist for different character classes.",
    initial: { byId: new Map() },
  });
  // Seed default. Modules that need other profiles register them at boot.
  buf.data.byId.set(DEFAULT_PLAYER_PROFILE.id, DEFAULT_PLAYER_PROFILE);
  return buf;
}
