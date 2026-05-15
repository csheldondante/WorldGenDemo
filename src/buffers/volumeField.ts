import { createBuffer, type Buffer } from "../runtime/buffer";
import type { GravityVolume } from "../lib/math/gravityVolume";

export interface VolumeFieldBufferData {
  /** Universal gravity (m/s²). Used by entities outside all `volumes`. */
  gravity: [number, number, number];
  /** Optional scene-author-declared regions that override universal gravity. The
   *  highest-priority volume containing an entity wins. See `src/lib/math/gravityVolume.ts`. */
  volumes: GravityVolume[];
}

export const VOLUME_FIELD_BUFFER_ID = "volumeField";

export function createVolumeFieldBuffer(): Buffer<VolumeFieldBufferData> {
  return createBuffer<VolumeFieldBufferData>({
    id: VOLUME_FIELD_BUFFER_ID,
    description:
      "Universal gravity vector + a list of named gravity volumes (sphere/cylinder/AABB shapes carrying constant or radial-to-axis fields). ForceFieldSystem picks the highest-priority volume containing each entity per tick, or falls back to universal gravity if none match. Scene-author-declared via SceneFile.gravityVolumes.",
    initial: { gravity: [0, -9.81, 0], volumes: [] },
  });
}
