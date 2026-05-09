import { createBuffer, type Buffer } from "../runtime/buffer";
import type { SurfaceProvider } from "../world/surfaceProvider";

export interface SurfaceProviderBufferData {
  /** Active heightmap-derived provider for the current scene; null until a rebuild produces a heightmap. */
  heightmap: SurfaceProvider | null;
}

export const SURFACE_PROVIDER_BUFFER_ID = "surfaceProvider";

export function createSurfaceProviderBuffer(): Buffer<SurfaceProviderBufferData> {
  return createBuffer<SurfaceProviderBufferData>({
    id: SURFACE_PROVIDER_BUFFER_ID,
    description:
      "Active SurfaceProvider instances. V1 has one slot (the per-scene heightmap surface); HeightmapSystem populates it during Rebuilding.",
    initial: { heightmap: null },
  });
}
