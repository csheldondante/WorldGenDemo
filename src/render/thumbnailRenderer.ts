import * as THREE from "three";
import { ALL_TERRAINS, type TerrainId } from "../core/types";
import { TerrainCatalog } from "../terrain/catalog";
import { AssetCatalog } from "../assets/catalog";
import { buildProceduralTextures } from "../terrain/textures";
import { mulberry32 } from "../core/rng";

const THUMB_SIZE = 64;

/**
 * Returns a Map<catalogId, dataURL> for every terrain id and every registered
 * asset id. Generated lazily on first call; subsequent calls return the cached
 * map. Safe to call multiple times.
 */
let _cache: Map<string, string> | null = null;

export function generateThumbnails(): Map<string, string> {
  if (_cache) return _cache;
  const out = new Map<string, string>();

  // Terrains: sample a 64×64 region of each procedural texture.
  const textures = buildProceduralTextures();
  for (const t of ALL_TERRAINS) {
    const baseKey = TerrainCatalog.get(t as TerrainId).baseTextureKey;
    const tex = textures[baseKey as keyof typeof textures];
    if (!tex) continue;
    const url = sampleTextureToDataURL(tex);
    if (url) out.set(t, url);
  }

  // Assets: render each procedural geometry to an offscreen canvas at THUMB_SIZE.
  for (const id of AssetCatalog.ids()) {
    try {
      const url = renderAssetThumbnail(id);
      if (url) out.set(id, url);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[thumbnails] asset "${id}" thumbnail failed:`, err);
    }
  }

  _cache = out;
  return out;
}

/** Reset cache — used by tests to reset between runs. */
export function resetThumbnailCache(): void {
  _cache = null;
}

function sampleTextureToDataURL(tex: THREE.Texture): string | null {
  // tex.image is a HTMLCanvasElement (from buildProceduralTextures). We sample
  // the top-left THUMB_SIZE×THUMB_SIZE region — close enough for a thumbnail.
  const src = tex.image as HTMLCanvasElement | undefined;
  if (!src) return null;
  const dst = document.createElement("canvas");
  dst.width = THUMB_SIZE;
  dst.height = THUMB_SIZE;
  const ctx = dst.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, THUMB_SIZE, THUMB_SIZE);
  return dst.toDataURL("image/png");
}

function renderAssetThumbnail(id: string): string | null {
  const spec = AssetCatalog.get(id);
  // Build the geometry with a small fixed RNG and a synthetic footprint —
  // we just want SOME instance to render.
  const rng = mulberry32(0xdada);
  const fakeFootprint = {
    componentId: 0,
    assetId: id,
    pixels: 1,
    area: 1,
    centroid: [0, 0] as [number, number],
    hull: [],
    obb: { center: [0, 0] as [number, number], axisU: [1, 0] as [number, number], axisV: [0, 1] as [number, number], halfU: 0.5, halfV: 0.5 },
    principalAxis: [1, 0] as [number, number],
    attachContacts: new Map(),
  };
  const baked = spec.generate(rng, fakeFootprint, { terrainBelow: undefined, extentU: 1, extentV: 1 });
  const geom = baked.geometry;
  geom.computeBoundingBox();
  const bb = geom.boundingBox!;
  const cx = (bb.min.x + bb.max.x) * 0.5;
  const cy = (bb.min.y + bb.max.y) * 0.5;
  const cz = (bb.min.z + bb.max.z) * 0.5;
  const sx = bb.max.x - bb.min.x;
  const sy = bb.max.y - bb.min.y;
  const sz = bb.max.z - bb.min.z;
  const radius = Math.max(sx, sy, sz) * 0.5 || 1;

  const canvas = document.createElement("canvas");
  canvas.width = THUMB_SIZE;
  canvas.height = THUMB_SIZE;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setClearColor(0x1a1f28, 1.0);

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(geom, baked.material);
  mesh.position.set(-cx, -cy, -cz);
  scene.add(mesh);

  scene.add(new THREE.HemisphereLight(0xddeeff, 0x303030, 0.7));
  const dir = new THREE.DirectionalLight(0xffffee, 1.1);
  dir.position.set(2, 3, 2);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  // 3/4 angle camera framing the geometry's bounding sphere.
  const dist = radius * 3.2;
  camera.position.set(dist * 0.7, dist * 0.7, dist * 0.7);
  camera.lookAt(0, 0, 0);

  renderer.render(scene, camera);
  const url = canvas.toDataURL("image/png");

  // Best-effort cleanup; the renderer is single-use.
  renderer.dispose();
  return url;
}
