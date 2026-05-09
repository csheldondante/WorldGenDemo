import { createBuffer, type Buffer } from "../runtime/buffer";

export interface VolumeFieldBufferData {
  /** Constant world gravity (m/s²). V1 default: -9.81 on Y. */
  gravity: [number, number, number];
}

export const VOLUME_FIELD_BUFFER_ID = "volumeField";

export function createVolumeFieldBuffer(): Buffer<VolumeFieldBufferData> {
  return createBuffer<VolumeFieldBufferData>({
    id: VOLUME_FIELD_BUFFER_ID,
    description:
      "Force fields acting on volume-constrained entities. V1 has just one constant-downward gravity vector. Future: arrays of localized fields (wind, low-G zones, etc).",
    initial: { gravity: [0, -9.81, 0] },
  });
}
