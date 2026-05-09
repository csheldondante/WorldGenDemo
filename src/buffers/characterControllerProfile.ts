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
  /** Maximum surface-tangent speed under normal run, m/s. */
  runSpeed: number;
  /** Acceleration toward desired velocity on the ground, m/s². */
  runAccel: number;
  /** Deceleration when no input on the ground, m/s². */
  runBrake: number;
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
}

export interface CharacterControllerProfileBufferData {
  byId: Map<ProfileId, CharacterControllerProfile>;
}

export const CHARACTER_CONTROLLER_PROFILE_BUFFER_ID = "characterControllerProfile";

export const DEFAULT_PLAYER_PROFILE: CharacterControllerProfile = {
  id: "player",
  runSpeed: 8,
  runAccel: 40,
  runBrake: 30,
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
