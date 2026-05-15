import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

/**
 * Per-character surface-tangent projection of input + the orthonormal tangent frame
 * the character is operating in this tick. Written by `TangentInputMapperSystem` for
 * every surface-attached character (one tick per character per frame); read by
 * `CharacterControllerSystem` to drive the desired-velocity → required-accel math.
 *
 * `forwardTangent` and `rightTangent` are unit vectors in world coordinates. They form
 * a right-handed basis with the surface normal (rightTangent = forwardTangent × N).
 * Together they define "where forward and right are, projected onto the tangent plane
 * at the character's surface sample," accounting for both the camera yaw and the
 * surface's local orientation.
 *
 * `vDesF` / `vDesR` are scalar desired-velocity magnitudes along forwardTangent /
 * rightTangent (m/s). They're derived from the player's normalized move axes and the
 * controller profile's `desiredRunSpeed`.
 *
 * Airborne entities don't have a meaningful tangent frame; the mapper skips them and
 * the controller's airborne branch does not read this buffer. Stale entries from a
 * previous surface attachment are tolerated (and ignored).
 */
export interface CharacterTangentInputComponent {
  forwardTangent: [number, number, number];
  rightTangent: [number, number, number];
  vDesF: number;
  vDesR: number;
}

export interface CharacterTangentInputBufferData {
  byEntity: Map<EntityId, CharacterTangentInputComponent>;
}

export const CHARACTER_TANGENT_INPUT_BUFFER_ID = "characterTangentInput";

export function createCharacterTangentInputBuffer(): Buffer<CharacterTangentInputBufferData> {
  return createBuffer<CharacterTangentInputBufferData>({
    id: CHARACTER_TANGENT_INPUT_BUFFER_ID,
    description:
      "Per-character surface-tangent projection of input: orthonormal tangent basis (forwardTangent, rightTangent) at the character's surface sample, plus desired-velocity scalars (vDesF, vDesR) along those axes. Written by TangentInputMapperSystem for surface-attached characters; read by CharacterControllerSystem.",
    initial: { byEntity: new Map() },
  });
}
