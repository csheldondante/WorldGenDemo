export type TerrainId =
  | "desert"
  | "tundra"
  | "forest"
  | "plains"
  | "canyon_wall"
  | "water"
  | "path";

export const ALL_TERRAINS: readonly TerrainId[] = [
  "desert",
  "tundra",
  "forest",
  "plains",
  "canyon_wall",
  "water",
  "path",
];

export type LabelKind = "terrain" | "asset" | "none";

export interface SceneLabel {
  color: string; // "#rrggbb"
  kind: LabelKind;
  terrain?: TerrainId;
  asset?: string;
}

export interface SceneFile {
  name: string;
  tileSize: number;
  labels: SceneLabel[];
}

export type LabelIndex = number; // index into the resolved palette
export const NO_LABEL: LabelIndex = -1;

export interface Palette {
  colors: number[]; // packed 0xRRGGBB
  kinds: LabelKind[];
  terrains: (TerrainId | undefined)[];
  assets: (string | undefined)[];
}

export interface LabelMap {
  width: number;
  height: number;
  tileSize: number;
  palette: Palette;
  data: Int32Array; // length w*h, value = palette index or NO_LABEL
}

export interface TerrainMap {
  width: number;
  height: number;
  tileSize: number;
  // index into ALL_TERRAINS, or -1 if no terrain (only happens before fill, debug)
  data: Int32Array;
}

export interface AssetMap {
  width: number;
  height: number;
  tileSize: number;
  // asset id strings interned to small integers; 0 = none
  data: Int32Array;
  ids: string[]; // ids[i] for i>=1; ids[0] = ""
}

export interface Footprint {
  componentId: number;
  assetId: string;
  pixels: number; // count
  area: number;   // pixels * tileSize^2
  centroid: [number, number]; // world coords
  hull: [number, number][];   // world coords
  obb: {
    center: [number, number];
    axisU: [number, number]; // unit
    axisV: [number, number]; // unit, perp
    halfU: number;           // world units
    halfV: number;
  };
  principalAxis: [number, number]; // unit
  attachContacts: Map<TerrainId, { count: number; direction: [number, number] }>;
}

export interface Placement {
  assetId: string;
  position: [number, number, number];
  yaw: number;
  scale: [number, number, number];
}
