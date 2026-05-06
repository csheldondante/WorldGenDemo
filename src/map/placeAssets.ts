import * as THREE from "three";
import type { AssetMap, Footprint, Placement, TerrainMap } from "../core/types";
import type { Heightmap } from "./heightmap";
import { AssetCatalog, type AssetSpec } from "../assets/catalog";
import { connectedComponents } from "./components";
import { buildFootprint, terrainBeneath } from "./footprint";
import { mulberry32, subSeed } from "../core/rng";

export interface PlaceAssetsResult {
  meshes: THREE.Object3D[];
  placements: Placement[];
  warnings: string[];
}

function sampleHeight(hm: Heightmap, x: number, z: number): number {
  // x, z are world coords (origin at map center)
  const fx = x / hm.tileSize + hm.width * 0.5 - 0.5;
  const fz = z / hm.tileSize + hm.height * 0.5 - 0.5;
  const ix = Math.max(0, Math.min(hm.width - 1, Math.round(fx)));
  const iz = Math.max(0, Math.min(hm.height - 1, Math.round(fz)));
  return hm.data[iz * hm.width + ix];
}

function poissonInsideOBB(rng: () => number, fp: Footprint, spacing: number): [number, number][] {
  // Naive dart-throwing inside the OBB; fast for small N.
  const { obb } = fp;
  const u0 = -obb.halfU, u1 = obb.halfU;
  const v0 = -obb.halfV, v1 = obb.halfV;
  const area = (u1 - u0) * (v1 - v0);
  const target = Math.max(1, Math.floor(area / (spacing * spacing) * 0.7));
  const out: [number, number][] = [];
  let attempts = 0;
  const maxAttempts = target * 30;
  while (out.length < target && attempts < maxAttempts) {
    attempts++;
    const u = u0 + rng() * (u1 - u0);
    const v = v0 + rng() * (v1 - v0);
    const x = obb.center[0] + obb.axisU[0] * u + obb.axisV[0] * v;
    const y = obb.center[1] + obb.axisU[1] * u + obb.axisV[1] * v;
    let ok = true;
    for (const [px, py] of out) {
      const dx = px - x, dy = py - y;
      if (dx * dx + dy * dy < spacing * spacing) { ok = false; break; }
    }
    if (ok) out.push([x, y]);
  }
  return out;
}

function chooseAttachTerrain(fp: Footprint, allowed: string[]) {
  let best: { terrainId: string; count: number; direction: [number, number] } | null = null;
  for (const t of allowed) {
    const c = fp.attachContacts.get(t as any);
    if (!c) continue;
    if (!best || c.count > best.count) best = { terrainId: t, count: c.count, direction: c.direction };
  }
  return best;
}

export function placeAssets(opts: {
  assetMap: AssetMap;
  terrainMap: TerrainMap;
  heightmap: Heightmap;
  seed: number;
}): PlaceAssetsResult {
  const { assetMap, terrainMap, heightmap, seed } = opts;
  const components = connectedComponents(assetMap);
  const placements: Placement[] = [];
  const warnings: string[] = [];

  type Bucket = {
    spec: AssetSpec;
    instances: { matrix: THREE.Matrix4; placement: Placement }[];
    bakedFor?: Footprint;
    geometry?: THREE.BufferGeometry;
    material?: THREE.Material;
  };
  const buckets = new Map<string, Bucket>();

  for (const c of components) {
    const assetId = assetMap.ids[c.assetIdInterned];
    if (!AssetCatalog.has(assetId)) {
      warnings.push(`unknown asset "${assetId}", skipping component`);
      continue;
    }
    const spec = AssetCatalog.get(assetId);
    const fp = buildFootprint(c, assetMap, terrainMap, assetId);
    const tBeneath = terrainBeneath(c, assetMap, terrainMap);

    if (spec.placement.on_terrain && tBeneath && !spec.placement.on_terrain.includes(tBeneath as any)) {
      warnings.push(`asset "${assetId}" component ${c.id} on disallowed terrain "${tBeneath}", skipping`);
      continue;
    }

    if (spec.placement.attach_to) {
      const attach = chooseAttachTerrain(fp, spec.placement.attach_to);
      if (!attach) {
        warnings.push(`asset "${assetId}" component ${c.id} has no contact with required terrain ${spec.placement.attach_to.join("/")} — skipping`);
        continue;
      }
      // Snap centroid toward attach edge along the contact direction
      const reach = Math.max(fp.obb.halfU, fp.obb.halfV);
      fp.centroid[0] += attach.direction[0] * reach * 0.5;
      fp.centroid[1] += attach.direction[1] * reach * 0.5;
      // Stash the chosen attach direction onto the footprint via a sentinel
      (fp as any)._attachDir = attach.direction;
      (fp as any)._attachTerrain = attach.terrainId;
    }

    const compRng = mulberry32(subSeed(seed, `${assetId}#${c.id}`));
    const ctx = {
      terrainBelow: tBeneath,
      extentU: fp.obb.halfU * 2,
      extentV: fp.obb.halfV * 2,
    } as const;

    let bucket = buckets.get(assetId);
    if (!bucket) {
      const baked = spec.generate(compRng, fp, ctx);
      bucket = { spec, instances: [], bakedFor: fp, geometry: baked.geometry, material: baked.material };
      buckets.set(assetId, bucket);
    }

    function emit(positionXZ: [number, number], yawOverride?: number, scaleOverride?: [number, number, number]) {
      const x = positionXZ[0];
      const z = positionXZ[1];
      const y = sampleHeight(heightmap, x, z);
      let yaw = yawOverride ?? 0;
      if (yawOverride === undefined) {
        if (spec.placement.align === "principal") {
          yaw = Math.atan2(fp.principalAxis[1], fp.principalAxis[0]);
        } else if (spec.placement.align === "perpendicular_to_attach") {
          const dir = (fp as any)._attachDir as [number, number] | undefined;
          if (dir) yaw = Math.atan2(-dir[0], dir[1]); // tangent to the wall
          else yaw = compRng() * Math.PI * 2;
        } else {
          yaw = compRng() * Math.PI * 2;
        }
        if (spec.placement.face === "outward_from_attach") {
          const dir = (fp as any)._attachDir as [number, number] | undefined;
          if (dir) yaw = Math.atan2(-dir[1], -dir[0]); // face outward (away from the wall)
        }
      }

      const scale: [number, number, number] = scaleOverride ?? [1, 1, 1];
      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
        new THREE.Vector3(scale[0], scale[1], scale[2]),
      );
      const placement: Placement = {
        assetId,
        position: [x, y, z],
        yaw,
        scale,
      };
      bucket!.instances.push({ matrix: m, placement });
      placements.push(placement);
    }

    if (spec.placement.multiplicity === "fill") {
      const spacing = spec.placement.fillSpacing ?? 2.0;
      const samples = poissonInsideOBB(compRng, fp, spacing);
      for (const s of samples) emit(s);
    } else {
      // single placement at centroid, scaled to the OBB so the asset fills the blob
      const baseScale = spec.placement.baseScale ?? 1;
      const sx = Math.max(0.6, fp.obb.halfU * 2 * baseScale);
      const sz = Math.max(0.6, fp.obb.halfV * 2 * baseScale);
      emit(fp.centroid, undefined, [sx, 1, sz]);
    }
  }

  // Build InstancedMesh per bucket
  const meshes: THREE.Object3D[] = [];
  for (const [, bucket] of buckets) {
    const geom = bucket.geometry;
    const mat = bucket.material;
    if (!geom || !mat || bucket.instances.length === 0) continue;
    const mesh = new THREE.InstancedMesh(geom, mat, bucket.instances.length);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    for (let i = 0; i < bucket.instances.length; i++) {
      mesh.setMatrixAt(i, bucket.instances[i].matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    meshes.push(mesh);
  }

  return { meshes, placements, warnings };
}
