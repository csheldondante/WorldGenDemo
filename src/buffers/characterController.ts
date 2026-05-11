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

export interface CharacterControllerComponent {
  state: ControllerState;
  locomotionMode: LocomotionMode;
  profileId: ProfileId;
  /** Last reason the FSM transitioned, for the debug HUD. */
  lastTransitionReason: string;
  /** Time spent in the current state, seconds; reset on transition. */
  timeInState: number;
  /**
   * Angular velocity about world +Y (rad/s). Integrated each tick by
   * CharacterOrientationSystem under a critically-damped spring toward a
   * camera/movement-derived target yaw. Kept here (per-character) so future
   * AI entities can drive their own orientation with the same dynamics.
   */
  yawVel: number;
  /**
   * Gait clock phase in radians, [0, 2π). Advanced by GaitSystem at a rate
   * proportional to horizontal speed; consumed by FootIKSystem per leg using
   * `LegSpec.gaitPhaseOffset` to produce alternating stepping cycles.
   * Frozen at the current value when speed drops below `gaitMinSpeed`.
   */
  gaitPhase: number;
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
