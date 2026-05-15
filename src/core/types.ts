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

/**
 * Parametric surface spec used by gym scenes. When present on `SceneFile`, the
 * bitmap pipeline (parse/split/heightmap/JFA/terrainMesh/assetPlacement) is
 * skipped and `parametricSurfaceSystem` builds a `SurfaceProvider` + visual
 * mesh from this spec instead. See `src/world/parametricSurfaceProvider.ts`.
 */
export type ParametricSurfaceSpec =
  | {
      type: "plane";
      origin: [number, number, number];
      extentU: [number, number, number];
      extentV: [number, number, number];
    }
  | {
      type: "cylinder";
      axisOrigin: [number, number, number];
      axisDirection: [number, number, number];
      radius: number;
      height: number;
      concave: boolean;
    }
  | {
      type: "torus";
      center: [number, number, number];
      axisDirection: [number, number, number];
      majorRadius: number;
      minorRadius: number;
      concave: boolean;
    }
  | {
      /** Procedural heightmap: a single Gaussian dome on flat ground, wrapped in
       *  HeightmapSurfaceProvider. Use as a "regular terrain with a small bump" gym
       *  for centripetal-leave manual testing. */
      type: "heightmap-bump";
      /** Grid dimensions (cells). World extent = width × tileSize, height × tileSize. */
      width: number;
      height: number;
      tileSize: number;
      /** Max bump height at the dome's apex (m). */
      peak: number;
      /** Gaussian sigma in world units (m). Smaller → tighter curvature at apex
       *  → lower velocity threshold for centripetal-leave. */
      sigma: number;
    }
  | {
      /** Procedural heightmap: a flat-top mesa with a steep but smooth slope down
       *  on all sides. Gym for testing the "slow→walks down, fast→flies off the lip"
       *  centripetal-detach behavior on a realistic terrain shape. */
      type: "heightmap-mesa";
      /** Grid dimensions (cells). World extent = width × tileSize, height × tileSize. */
      width: number;
      height: number;
      tileSize: number;
      /** Mesa top elevation (m). */
      peak: number;
      /** Radius (world units, m) of the flat mesa top, centered at the world origin. */
      topRadius: number;
      /** Width of the lip/slope transition zone (world units). Smaller → sharper lip
       *  → lower velocity threshold for centripetal-leave at the edge. */
      slopeWidth: number;
    };

export interface SceneFile {
  name: string;
  tileSize: number;
  /** Bitmap labels — required for bitmap scenes; can be `[]` for parametric scenes. */
  labels: SceneLabel[];
  /** When present, the scene is parametric: skip the bitmap pipeline; use the spec to
   *  build the surface and a visual mesh. The `labels` field can be `[]` in this case. */
  parametric?: ParametricSurfaceSpec;
  /** Optional spawn UV [u, v] on the surface. Defaults to (0.5, 0.5) for parametric. */
  spawn?: { uv: [number, number] };
  /** Optional gravity volumes — scene-author-declared regions that override universal
   *  gravity. See `src/lib/math/gravityVolume.ts`. Copied into `VolumeFieldBuffer.volumes`
   *  on rebuild. */
  gravityVolumes?: GravityVolumeSpec[];
}

/** JSON-friendly mirror of `GravityVolume` in `src/lib/math/gravityVolume.ts`. Kept here so
 *  scene-file consumers (loadScene, parseBitmap) don't pull lib types into core/types. */
export type GravityVolumeSpec = {
  shape:
    | { type: "sphere"; center: [number, number, number]; radius: number }
    | {
        type: "cylinder";
        axisOrigin: [number, number, number];
        axisDirection: [number, number, number];
        radius: number;
        halfHeight: number;
      }
    | { type: "aabb"; min: [number, number, number]; max: [number, number, number] };
  field:
    | { type: "constant"; vector: [number, number, number] }
    | {
        type: "radial";
        axisOrigin: [number, number, number];
        axisDirection: [number, number, number];
        direction: "toward" | "away";
        magnitude: number;
      };
  priority: number;
};

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
