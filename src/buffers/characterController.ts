import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";
import type { ProfileId } from "./characterControllerProfile";

/** FSM states. New states get added to this union; threshold-based transitions are owned by CharacterControllerSystem. */
export type ControllerState =
  | "surfaceRun"   // grounded, accepts move/jump input
  | "surfaceSlide" // grounded but slope too steep; sliding downhill, limited steering
  | "airborne"     // volume-constrained, no winged moves yet (post-jump or fell off)
  | "wingLaunch"   // brief upward boost from a long-held jump; transitions to airborne
  | "flap"         // single-tick impulse; transitions to airborne
  | "glide";       // airborne with reduced gravity + forward accel while jump is held

export type LocomotionMode = "surfaceConstrained" | "volumeConstrained";

/** Single state transition record kept in a ring buffer on the controller for debug HUD. */
export interface ControllerTransition {
  /** State the entity transitioned from. */
  from: ControllerState;
  /** State the entity transitioned to. */
  to: ControllerState;
  /** Locomotion mode after the transition (may differ from before — e.g. surfaceRun→airborne). */
  locomotion: LocomotionMode;
  /** Wall-clock-ish timestamp (`now` from the scheduler tick) in MILLISECONDS
   *  — this is `performance.now()`, NOT seconds. `dt` elsewhere is seconds; don't mix them. */
  t: number;
  /** Human-readable reason set at the transition site. */
  reason: string;
}

export interface CharacterControllerComponent {
  state: ControllerState;
  locomotionMode: LocomotionMode;
  profileId: ProfileId;
  /** Last reason the FSM transitioned, for the debug HUD. */
  lastTransitionReason: string;
  /** Time spent in the current state, seconds; reset on transition. */
  timeInState: number;
  /** Ring buffer of recent state transitions for the debug HUD. Oldest first; bounded to ~10 entries. */
  transitions: ControllerTransition[];
  /**
   * Angular velocity about world +Y (rad/s). Integrated each tick by
   * CharacterOrientationSystem under a critically-damped spring toward
   * `targetYaw`. Kept here (per-character) so future AI entities can drive
   * their own orientation with the same dynamics.
   */
  yawVel: number;
  /**
   * Desired body yaw the orientation controller is chasing. Latched: updates
   * only when the player actively applies look input (mouse or right stick).
   * When camera is idle the body holds this heading even while strafing —
   * makes it easy to debug the gait from the side.
   */
  targetYaw: number;
  /**
   * Smoothed body-up direction in world space (quaternion). BodyLeanSystem
   * computes a target each tick from the apparent-gravity solver and slerps
   * this toward it with `leanResponsiveness`. The pelvis bone's localRot is
   * derived from this so the lean visibly damps rather than snapping.
   * Initialized to identity (0,0,0,1) on spawn.
   */
  bodyUpCurrent: [number, number, number, number];
  /**
   * Reserved for the future orientation FSM (Phase C). `target` is set by state transitions
   * (e.g. surfaceRun: head=N; wallClimb: head=worldUp, face=-N; tumble: free-rotate). `current`
   * slerps toward target at orientationSlerpRate × dt. RenderSync reads `current`; the linear
   * solver does not. Stored as quaternions [x, y, z, w]; initialized to identity [0,0,0,1].
   */
  orientation: {
    current: [number, number, number, number];
    target: [number, number, number, number];
  };
}

export interface CharacterControllerBufferData {
  byEntity: Map<EntityId, CharacterControllerComponent>;
}

export const CHARACTER_CONTROLLER_BUFFER_ID = "characterController";

export function createCharacterControllerBuffer(): Buffer<CharacterControllerBufferData> {
  return createBuffer<CharacterControllerBufferData>({
    id: CHARACTER_CONTROLLER_BUFFER_ID,
    description:
      "Per-character FSM state (surfaceRun/airborne/jump/etc), locomotion mode, profile reference, and the last transition reason for the debug HUD.",
    initial: { byEntity: new Map() },
  });
}
