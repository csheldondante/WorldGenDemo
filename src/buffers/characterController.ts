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
  /** True iff the jump button was held last tick (used to detect short release). */
  jumpHeldLastTick: boolean;
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
