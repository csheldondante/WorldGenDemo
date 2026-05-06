import type { TerrainId } from "../core/types";
import { ALL_TERRAINS } from "../core/types";

export interface TerrainSpec {
  id: TerrainId;
  baseTextureKey: string;
  elevation: number;
  /** RGB tint applied on top of the base texture */
  tint: [number, number, number];
  flags: { wall?: true; liquid?: true };
}

const SPECS: Record<TerrainId, TerrainSpec> = {
  desert:      { id: "desert",      baseTextureKey: "sand",  elevation: 0.4, tint: [0.95, 0.85, 0.6],  flags: {} },
  tundra:      { id: "tundra",      baseTextureKey: "snow",  elevation: 0.8, tint: [0.95, 0.97, 1.0],  flags: {} },
  forest:      { id: "forest",      baseTextureKey: "grass", elevation: 0.5, tint: [0.35, 0.55, 0.3],  flags: {} },
  plains:      { id: "plains",      baseTextureKey: "grass", elevation: 0.4, tint: [0.6, 0.75, 0.45],  flags: {} },
  canyon_wall: { id: "canyon_wall", baseTextureKey: "rock",  elevation: 4.5, tint: [0.55, 0.32, 0.22], flags: { wall: true } },
  water:       { id: "water",       baseTextureKey: "water", elevation: -0.4, tint: [0.18, 0.36, 0.55], flags: { liquid: true } },
  path:        { id: "path",        baseTextureKey: "dirt",  elevation: 0.3, tint: [0.5, 0.4, 0.3],    flags: {} },
};

export const TerrainCatalog = {
  has(id: string): id is TerrainId {
    return (ALL_TERRAINS as readonly string[]).includes(id);
  },
  get(id: TerrainId): TerrainSpec {
    return SPECS[id];
  },
  list(): TerrainSpec[] {
    return ALL_TERRAINS.map((id) => SPECS[id]);
  },
  index(id: TerrainId): number {
    return ALL_TERRAINS.indexOf(id);
  },
  fromIndex(i: number): TerrainId | undefined {
    return ALL_TERRAINS[i];
  },
};
