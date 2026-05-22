import { createBuffer, type Buffer } from "../runtime/buffer";
import type { LinearAccelCurve } from "../lib/math/accelCurve";

export type ProfileId = string;

/**
 * Tunable movement parameters for a class of character. All knobs that affect
 * "feel" live here — code reads, never bakes constants. Multiple profiles can
 * coexist (player vs NPC, light/heavy variants); CharacterControllerComponent
 * references one by ID.
 */
export interface CharacterControllerProfile {
  id: ProfileId;
  /** Maximum surface-tangent speed under normal run, m/s. Inputs map to a desired velocity scaled by this.
   *  Conventionally equals `forwardAccel.vMax` — the speed at which forward accel reaches zero. */
  desiredRunSpeed: number;
  /** Max self-applied accel along character +forward, as a curve of (max accel) vs (current forward velocity).
   *  At currentV=0 you get `accelAtZero` m/s²; at currentV=vMax you get 0. External tangent accelerations
   *  (gravity along slope, etc.) effectively shift this curve — so the equilibrium speed drops on uphill
   *  and rises on downhill without any special-case code in the controller. Capped further by gripBudget. */
  forwardAccel: LinearAccelCurve;
  /** Max self-applied accel along character -forward. Symmetric model: evaluated at max(0, -vF) so braking
   *  from forward motion (vF>0) gets the full accelAtZero, while backing up (vF<0) ramps down as |vF| grows. */
  backwardAccel: LinearAccelCurve;
  /** Max self-applied accel along character ±right. Evaluated at abs(vR) — symmetric for left/right strafing. */
  lateralAccel: LinearAccelCurve;
  /** Max self-applied accel along surface +normal (boost off the surface). Conventionally vMax=Infinity —
   *  this is a grip budget, not a velocity-shaped curve. Jump uses impulse instead. */
  upAccel: LinearAccelCurve;
  /** Self-applied force into the surface (m/s² along -N). Two roles:
   *   1. Scales friction-grip on the tangent plane: tangentGrip = μ × (|gravity·N| + downAccel).
   *      Run sets this to 0 — legs aren't pressing; gravity supplies all the normal load.
   *      Climb sets this high (≈20 m/s²) — legs actively press into walls/overhangs to
   *      generate friction grip where gravity's into-N component alone is ~0.
   *   2. Detach-resist budget: the centripetal-aware leave-surface rule reads it at
   *      `max(0, vN_current)`; if the surface needs to PULL the body in harder than this
   *      budget allows, the body detaches.
   *   Conventionally vMax=Infinity (constant force regardless of vN). */
  downAccel: LinearAccelCurve;
  /** Multiplier on surface.normalInMax: required normal-in > scale × cap → enter ragdoll. */
  ragdollNormalInScale: number;
  /** Multiplier on surface.normalOutMax: required normal-out > scale × cap → detach to airborne. */
  detachNormalOutScale: number;
  /** Multiplier on grip budget: required tangent force > scale × budget → slip into surfaceSlide. */
  slideGripScale: number;
  /** Aerial control acceleration in volume mode, m/s². Deliberately small —
   *  this is a fine-tuning concession for joystick fidelity, not a re-aim
   *  channel. The jump press captures most of the intent; in-air thrust is
   *  small enough that you can't repeat-correct against a wall. */
  airAccel: number;
  /** Aerial maximum horizontal speed cap from THRUST (not total absolute
   *  velocity). You can carry higher speeds through the air from takeoff;
   *  this just bounds how much speed pure airborne steering can add. */
  airSpeedCap: number;
  /** Jump-move profile. Single cluster for the basic jump's tunables —
   *  groundwork for the future "moves are composable, profile-bound units"
   *  architecture (see controller library vision). Variants like reverse-
   *  flip / wall-jump / dive should become separate JumpProfiles / FSM
   *  states with their own values, NOT flag-bonus fields layered on top
   *  of this one. */
  jump: {
    /** Vertical component of the "intended jump velocity" at full hold, m/s.
     *  Hold full → vertical velocity reaches this value (plus near-zero
     *  ground residual). Shorter holds apply a fraction. */
    upSpeed: number;
    /** Target horizontal speed when joystick is fully deflected at press,
     *  m/s. Direction = joystick (purely); magnitude blends from current
     *  speed toward this value via `horizBlendMax`. */
    horizSpeed: number;
    /** How strongly the joystick-targeted speed replaces current speed at
     *  press, in [0, 1]. Scales with joystick magnitude. */
    horizBlendMax: number;
    /** Hold window during which the impulse continues to be applied along
     *  its initial direction, seconds. */
    holdMaxSec: number;
    /** Discrete energy steps within the hold window for press-timing-snap.
     *  4 = quartiles; 1 = continuous. */
    stepCount: number;
    /** Maximum angle the press-time impulse can dip below world horizontal,
     *  radians. The impulse is also clamped to never point into the surface
     *  (so jumping into a slope is reflected up along the slope tangent,
     *  and jumping into a steep enough wall pushes up the wall instead of
     *  through it). 0.174 ≈ 10°. */
    maxAngleBelowHorizonRad: number;
    /** Floor on the surface-orientation jump-force scale. The jump impulse
     *  magnitude is multiplied by `max(minSurfaceScale, N · gravityUp)` —
     *  full strength on flat ground, reduced when the body is on a slope
     *  whose normal isn't aligned with gravity-up (because there's less
     *  friction budget left over after holding against tangent gravity).
     *  Floor of 0.2 means even on a vertical wall you can muster 20% of a
     *  full jump — "last push up" rather than "leap to scale it." */
    minSurfaceScale: number;
  };
  /** Climb sub-profile. Selected by FSM state — when `ctrl.state === "climb"`,
   *  the controller reads these curves instead of the top-level run curves.
   *  Same 6DoF shape (forward/backward/lateral/up/down accel) as the run
   *  curves; tuned for "high acceleration, very low top speed" so the body
   *  pins to steep / vertical surfaces with strong grip and moves slowly.
   *  `engagementMaxSpeed` is the tangent-speed threshold that gates the
   *  transition INTO climb from run or slide. Same pattern as `jump` — per-
   *  state parameter bundle, picked by FSM state. */
  climb: {
    forwardAccel: LinearAccelCurve;
    backwardAccel: LinearAccelCurve;
    lateralAccel: LinearAccelCurve;
    upAccel: LinearAccelCurve;
    /** Same role as the top-level `downAccel` — climb sets this high so the
     *  body actively presses into the surface, generating friction grip on
     *  walls/overhangs where gravity's into-N component is ~0. */
    downAccel: LinearAccelCurve;
    /** Tangent-speed threshold (m/s) below which run / slide → climb fires
     *  on a slope steeper than `slopeRunMaxRad`. Also gates climb → slide
     *  when exceeded by an external impulse. */
    engagementMaxSpeed: number;
  };
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
  /**
   * Velocity-transfer efficiency at a disc-corner UV jump (multi-contact
   * curvature transition). The body's pre-jump speed magnitude is preserved
   * in the new tangent direction times this factor. 1.0 = lossless transfer
   * (agile character — forward motion onto a slope or wall converts fully
   * into up-along-the-new-surface motion). <1.0 = inelastic transfer (less
   * agile — some energy lost at the corner). Default 1.0. */
  cornerTransferEfficiency: number;

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
  /** Hard ceiling on lean angle from surface normal (rad). Used as the forward cap. */
  maxLeanAngle: number;
  /**
   * Tighter ceiling on backward lean (rad). Braking should look controlled,
   * not like a stumble — most bipeds barely lean back when stopping.
   */
  maxBackwardLeanAngle: number;
  /**
   * 0..1. As the support surface tilts away from world up, blend the body-up
   * target toward world up by `steepness × this`. On flat ground no change;
   * on a wall (normal perpendicular to world up) full blend, body stays
   * vertical against gravity even with the foot on a wall.
   */
  steepSlopeWorldUpBias: number;
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
  // accelAtZero values match the pre-curve scalar caps so v=0 behavior is identical.
  // Finite vMax on tangent curves makes "external accel shifts the curve" work cleanly:
  // on a 30° uphill, gravity-along-slope = 4.9 m/s² → forward equilibrium drops from 8 to
  // ~7.0 m/s without any per-state code; on downhill it rises symmetrically above 8.
  forwardAccel: { accelAtZero: 40, vMax: 8 },
  backwardAccel: { accelAtZero: 25, vMax: 6 },
  lateralAccel: { accelAtZero: 35, vMax: 8 },
  // Normal curves stay constant — they're grip budgets, not velocity-shaped thrust.
  // Phase 4's leave rule reads downAccel at max(0,vN) → at attached (vN=0) returns accelAtZero.
  upAccel: { accelAtZero: 5, vMax: Infinity },
  // Run sets downAccel=0 — body doesn't actively press into the ground;
  // gravity supplies the normal load and friction. Climb sets it high (≈20)
  // to grip walls/overhangs where gravity's into-N component is ~0.
  // The friction-grip formula reads this curve to compute selfNormalPush.
  downAccel: { accelAtZero: 0, vMax: Infinity },
  ragdollNormalInScale: 1.5,
  detachNormalOutScale: 1.0,
  slideGripScale: 1.0,
  airAccel: 1.5,
  airSpeedCap: 2,
  jump: {
    upSpeed: 7,
    horizSpeed: 4,
    horizBlendMax: 0.5,
    holdMaxSec: 0.18,
    stepCount: 4,
    maxAngleBelowHorizonRad: 0.174,
    minSurfaceScale: 0.2,
  },
  // Climb sub-profile — "high acceleration, very low top speed." vMax ≈ 2 m/s
  // (a quarter of run speed); accelAtZero raised so the body grips and can push
  // against gravity on overhangs. downAccel cranked above gravity (≈ 20 m/s²) so
  // the existing centripetal-leave rule keeps the body stuck even on ceilings.
  climb: {
    forwardAccel: { accelAtZero: 30, vMax: 2 },
    backwardAccel: { accelAtZero: 30, vMax: 2 },
    lateralAccel: { accelAtZero: 30, vMax: 2 },
    upAccel: { accelAtZero: 20, vMax: Infinity },
    downAccel: { accelAtZero: 20, vMax: Infinity },
    engagementMaxSpeed: 1.5,
  },
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
  cornerTransferEfficiency: 1.0, // lossless — forward motion converts fully to up-the-wall at corners.
  desiredTurnRate: 6,         // rad/s — ~344°/s; can do a 180° in ~0.55s once at speed.
  turnAccelMax: 40,           // rad/s² — reaches max turn rate in 0.15s.
  turnPGain: 8,               // rad/s per rad offset; saturates to desiredTurnRate at ~0.75 rad (43°).
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
  maxLeanAngle: 0.6,            // ~34° forward / lateral ceiling.
  maxBackwardLeanAngle: 0.18,   // ~10° backward ceiling — braking stays composed.
  steepSlopeWorldUpBias: 0.9,   // strong pull toward world up on steep slopes.
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
