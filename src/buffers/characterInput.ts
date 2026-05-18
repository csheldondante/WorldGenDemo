import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

/**
 * Per-character input snapshot for the current tick. CharacterInputSystem
 * fills this from raw InputBuffer keys (or other sources, e.g. AI in future).
 *
 * `move{X,Y}` are normalized [-1, 1] in the input plane; the controller
 * resolves them into the locomotion frame. `jumpDown` is the edge-triggered
 * "pressed this tick" signal; `jumpHeld` is held duration in seconds.
 */
export interface CharacterInputComponent {
  moveX: number;
  moveY: number;
  jumpPressed: boolean;     // edge: true on the tick the button went down
  jumpReleased: boolean;    // edge: true on the tick the button went up
  jumpHeld: boolean;        // held this tick
  jumpHoldSec: number;      // accumulated time held; reset on release
  /** Camera-yaw-only frame, in radians. Legacy; used by airborne path which
   *  still operates in world XZ. Surface-attached path should prefer
   *  `cameraLookDir` since the yaw reconstruction loses the camera's
   *  vertical component (and thus its actual forward on curved gravity). */
  cameraYaw: number;
  /** Unit world-space camera look direction (where the camera is looking).
   *  Surface-attached projections should use this; projecting it onto the
   *  tangent plane recovers the screen-forward direction on the puck's
   *  surface, regardless of how the camera is oriented to world-Y. */
  cameraLookDir: [number, number, number];
  /** Unit world-space camera "up" reference — `cam.pivot.up`, the local
   *  gravity-up at the pivot. Together with `cameraLookDir` it spans the
   *  camera's vertical plane; consumers project that plane onto the surface
   *  tangent plane to recover "forward on stick" stably when `lookDir`
   *  approaches the surface normal (steep-hill crest, torus inside-curl).
   *  See `src/lib/math/cameraTangent.ts`. */
  cameraUp: [number, number, number];
}

export interface CharacterInputBufferData {
  byEntity: Map<EntityId, CharacterInputComponent>;
}

export const CHARACTER_INPUT_BUFFER_ID = "characterInput";

export function createCharacterInputBuffer(): Buffer<CharacterInputBufferData> {
  return createBuffer<CharacterInputBufferData>({
    id: CHARACTER_INPUT_BUFFER_ID,
    description:
      "Per-character input state: normalized move axes, jump edges + hold duration, camera yaw frame. Filled by CharacterInputSystem from InputBuffer + CameraBuffer; read by CharacterControllerSystem.",
    initial: { byEntity: new Map() },
  });
}

export function emptyInput(cameraYaw = 0): CharacterInputComponent {
  return {
    moveX: 0, moveY: 0,
    jumpPressed: false, jumpReleased: false, jumpHeld: false, jumpHoldSec: 0,
    cameraYaw,
    cameraLookDir: [0, 0, -1],
    cameraUp: [0, 1, 0],
  };
}
