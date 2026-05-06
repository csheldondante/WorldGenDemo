import * as THREE from "three";
import type { Footprint, TerrainId } from "../core/types";
import type { Rng } from "../core/rng";

export interface BakedAsset {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface PlacementRules {
  multiplicity?: "one" | "fill";
  on_terrain?: TerrainId[];
  attach_to?: TerrainId[];
  align?: "principal" | "perpendicular_to_attach" | "free";
  face?: "outward_from_attach" | "free";
  fillSpacing?: number;
  /** override default per-instance scale (worldUnitsPerPixel = tileSize) */
  baseScale?: number;
}

export interface AssetGenerateContext {
  terrainBelow: TerrainId | undefined;
  /** approximate world-units extent of the footprint along principal/perp axes */
  extentU: number;
  extentV: number;
}

export interface AssetSpec {
  id: string;
  generate(rng: Rng, footprint: Footprint, ctx: AssetGenerateContext): BakedAsset;
  placement: PlacementRules;
}

const REGISTRY = new Map<string, AssetSpec>();

export const AssetCatalog = {
  register(spec: AssetSpec): void {
    REGISTRY.set(spec.id, spec);
  },
  has(id: string): boolean {
    return REGISTRY.has(id);
  },
  get(id: string): AssetSpec {
    const spec = REGISTRY.get(id);
    if (!spec) throw new Error(`AssetCatalog: unknown asset "${id}"`);
    return spec;
  },
  ids(): string[] {
    return Array.from(REGISTRY.keys());
  },
  reset(): void {
    REGISTRY.clear();
  },
};
