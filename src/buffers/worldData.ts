import { createBuffer, type Buffer } from "../runtime/buffer";
import type { LabelMap, TerrainMap, AssetMap } from "../core/types";
import type { Heightmap } from "../map/heightmap";
import type { JfaResult } from "../map/jfa";

export interface WorldDataBufferData {
  sceneName: string | null;
  image: HTMLImageElement | null;
  labelMap: LabelMap | null;
  terrainMap: TerrainMap | null;
  assetMap: AssetMap | null;
  heightmap: Heightmap | null;
  jfa: JfaResult | null;
}

export const WORLD_DATA_BUFFER_ID = "worldData";

export function createWorldDataBuffer(): Buffer<WorldDataBufferData> {
  return createBuffer<WorldDataBufferData>({
    id: WORLD_DATA_BUFFER_ID,
    description: "Per-scene data: source bitmap, parsed maps, heightmap, JFA outputs. Each pipeline stage writes its slice.",
    initial: {
      sceneName: null,
      image: null,
      labelMap: null,
      terrainMap: null,
      assetMap: null,
      heightmap: null,
      jfa: null,
    },
  });
}
