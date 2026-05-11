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

  // --- Footstep planner (plant-and-step model) ------------------------------
  // Each foot stays at a world plant position until the hip drifts beyond
  // `footUnplantDistance`, at which point it swings (over `footSwingDuration`)
  // to a new plant point ahead of the body's current position. Forward lead
  // = velocity × footPlantLeadTime so plants land where the hip *will* be.
  // --------------------------------------------------------------------------
  /** Horizontal distance the hip can drift from a planted foot before that foot starts a swing (m). */
  footUnplantDistance: number;
  /** Body yaw delta (rad) since plant before that foot starts a swing. Lets turn-in-place
   *  trigger steps even when translation drift is small (hip-spread on a biped is only ~0.1m). */
  footUnplantYawDelta: number;
  /** Base swing duration when transitioning a foot to a new plant (s). Longer-distance swings extend this slightly. */
  footSwingDuration: number;
  /** Per-(m/s)-of-speed reduction in swing duration. Effective = base / (1 + factor·speed),
   *  clamped to `footMinSwingDuration`. At v=8 with factor=0.18 swings finish in ~0.09s
   *  so the back leg recovers before the body has run past max reach. */
  footSwingSpeedFactor: number;
  /** Lower bound on the speed-scaled swing duration (s). */
  footMinSwingDuration: number;
  /** Extra lookahead beyond `footSwingDuration` when predicting plant target (s).
   *  Plant target = surface(hip + velocity · (swingDuration + leadTime)) — so the
   *  foot lands ahead of where the hip will be when the swing finishes. Without
   *  this the body strides past the plant during the swing and feet trail behind. */
  footPlantLeadTime: number;
  /** Fraction of max leg reach (L1 + L2) at which the planter forces a swing even if
   *  the other foot is still swinging. Stops the stance leg from getting yanked into a
   *  fully-extended straight line during sprints (the visible "stilted leg" artifact). */
  footMaxReachStretch: number;
  /** Peak vertical lift during swing, meters. */
  footStepHeight: number;
  /** Below this horizontal speed the foot planner returns plants to under-hip for balance, not ahead (m/s). */
  footStandingSpeed: number;
  /**
   * Brake-plant: when the body is decelerating along its direction of motion,
   * extend the swing's plant lookahead by `decel · footBrakeLeadGain` seconds,
   * clamped to `footBrakeLeadMax` seconds. Result: the foot lands further
   * forward of the hip during deceleration, visually anchoring the stop.
   */
  footBrakeLeadGain: number;
  /** Hard cap on the brake-lead extension (s). */
  footBrakeLeadMax: number;

  // --- Airborne anim --------------------------------------------------------
  /** Forward-pitch bias (rad) added to the spine chain target while airborne,
   *  scaled by horizontal speed factor. Approximates the angular-momentum
   *  pitch a real biped carries off a forward jump so feet land in front of
   *  CoM. Spring dynamics naturally ease it in/out at takeoff and landing. */
  airborneForwardPitch: number;

  // --- Body lean (apparent-gravity solver) ----------------------------------
  /** Implicit-drag coefficient (1/s). Effective accel = a_real + dragCoeff·v.
   *  Bigger value → more steady-state forward lean at running speed. */
  leanDragCoeff: number;
  /** Exponential smoothing rate for body-up chase (1/s). Time constant ≈ 1/this. */
  leanResponsiveness: number;
  /** Hard ceiling on lean angle from surface normal (rad). */
  maxLeanAngle: number;
  /** Multiplier on the geometric hip-drop from lean: drop = legLength·(1−cos(θ))·this. */
  leanCompressionScale: number;
  /** Extra pelvis drop from speed alone (m at `desiredRunSpeed`). Added on top of leanCompression. */
  pelvisSpeedCompression: number;
  /**
   * 0..1. How much of the static gravity-along-slope component the body
   * leans into. At 1.0 the body tips uphill on a slope as if it were
   * producing the force to hold itself there — visible "climber's lean."
   * On flat ground this term vanishes (no gravity along the tangent plane).
   */
  leanGravityCounterScale: number;
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
  // Foot planner: foot can drift 0.35m from under-hip before stepping; swing
  // ~0.22s; plant 0.18s ahead of hip → at 8 m/s plants land ~1.4m forward.
  footUnplantDistance: 0.18,
  footUnplantYawDelta: 0.35, // rad; ≈20° body turn before re-plant.
  footSwingDuration: 0.22,
  footSwingSpeedFactor: 0.10, // at v=8: swing ≈ 0.12s, keeps stance brief and cadence ~4 Hz/leg.
  footMinSwingDuration: 0.10,
  footPlantLeadTime: 0.04,    // small forward bias so plant lands ~ velocity·0.04 ahead of swing-end hip.
  footMaxReachStretch: 0.85,  // currently unused; reserved for a future "tuck under" emergency path.
  footStepHeight: 0.32,       // visible knee lift on stride — fast runners look bent, not stilted.
  footStandingSpeed: 0.15,
  footBrakeLeadGain: 0.008,   // 0.008 s extra lead per (m/s²) of decel; at 20 m/s² → +0.16s, but…
  footBrakeLeadMax: 0.05,     // …capped to 0.05 s additional lookahead so plants don't fly off.
  airborneForwardPitch: 0.28, // ~16° forward tilt in air at full speed; scaled by speed factor.
  leanDragCoeff: 0.5,         // at v=8 → ~22° steady-state forward lean (atan(4/9.81)).
  leanResponsiveness: 8.0,    // ~0.12 s time constant on body-up chase.
  maxLeanAngle: 0.6,          // ~34° hard ceiling.
  leanCompressionScale: 1.0,  // geometric hip drop = L·(1−cos θ) at scale 1.
  pelvisSpeedCompression: 0.08, // extra 8 cm drop at full run on top of geometric.
  leanGravityCounterScale: 1.0,
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
