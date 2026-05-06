import * as THREE from "three";
import type { TerrainMap, TerrainId } from "../core/types";
import { ALL_TERRAINS } from "../core/types";
import { TerrainCatalog } from "../terrain/catalog";

import jfaSeedFrag from "../shaders/jfaSeed.frag?raw";
import jfaStepFrag from "../shaders/jfaStep.frag?raw";
import jfaResolveFrag from "../shaders/jfaResolve.frag?raw";
import jfaGradFrag from "../shaders/jfaGradient.frag?raw";

const FULLSCREEN_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

export interface JfaResult {
  /** RGBA: per-pixel distance (in pixel units) to top-up-to-4 terrains */
  distance: THREE.Texture;
  /** RG: gradient (offset by 0.5) of the softmin distance — boundary normal */
  gradient: THREE.Texture;
  /** Order of terrain ids that ended up in R,G,B,A channels of the distance texture */
  channelTerrains: (TerrainId | null)[];
  /** Coverage (pixel counts) per terrain */
  coverage: Record<TerrainId, number>;
  /** Source size (pixels) */
  width: number;
  height: number;
  /** Disposes all owned GPU resources */
  dispose(): void;
}

function makeRT(
  width: number,
  height: number,
  format: THREE.AnyPixelFormat = THREE.RGBAFormat,
  type: THREE.TextureDataType = THREE.HalfFloatType,
) {
  return new THREE.WebGLRenderTarget(width, height, {
    format,
    type,
    magFilter: THREE.NearestFilter,
    minFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function terrainTexture(terrainMap: TerrainMap, totalSlots: number): THREE.DataTexture {
  const { width, height, data } = terrainMap;
  const buf = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = data[i] >= 0 ? data[i] : 0;
    buf[i * 4] = Math.round((v / totalSlots) * 255);
    buf[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(buf, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.flipY = true; // align with planar UVs that have v increasing upward
  tex.needsUpdate = true;
  return tex;
}

export function runJFA(renderer: THREE.WebGLRenderer, terrainMap: TerrainMap): JfaResult {
  const { width, height } = terrainMap;
  const totalSlots = 32;

  // Coverage per terrain
  const coverage: Record<string, number> = {};
  for (let i = 0; i < terrainMap.data.length; i++) {
    const t = TerrainCatalog.fromIndex(terrainMap.data[i]);
    if (!t) continue;
    coverage[t] = (coverage[t] ?? 0) + 1;
  }
  const ranked = ALL_TERRAINS.filter((t) => (coverage[t] ?? 0) > 0)
    .sort((a, b) => (coverage[b]! - coverage[a]!));
  const top4: (TerrainId | null)[] = [ranked[0] ?? null, ranked[1] ?? null, ranked[2] ?? null, ranked[3] ?? null];

  const terrainTex = terrainTexture(terrainMap, totalSlots);

  // Fullscreen quad
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
    -1, -1, 0, 1, -1, 0, -1, 1, 0,
    -1, 1, 0, 1, -1, 0, 1, 1, 0,
  ]), 3));
  geom.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1,
    0, 1, 1, 0, 1, 1,
  ]), 2));
  const fsScene = new THREE.Scene();
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(geom, new THREE.ShaderMaterial());
  fsScene.add(quad);

  const seedRTs: THREE.WebGLRenderTarget[] = [];
  for (let k = 0; k < 4; k++) {
    if (!top4[k]) { seedRTs.push(null as any); continue; }
    const rtA = makeRT(width, height);
    const rtB = makeRT(width, height);
    // Seed pass
    const seedMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: jfaSeedFrag,
      uniforms: {
        uTerrain: { value: terrainTex },
        uTargetIndex: { value: TerrainCatalog.index(top4[k]!) },
        uTotalTerrains: { value: totalSlots },
      },
    });
    quad.material = seedMat;
    renderer.setRenderTarget(rtA);
    renderer.render(fsScene, fsCam);

    // Jump-flooding
    const stepMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: jfaStepFrag,
      uniforms: {
        uPrev: { value: rtA.texture },
        uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
        uStride: { value: 1 },
      },
    });
    quad.material = stepMat;
    let src = rtA, dst = rtB;
    let stride = Math.max(width, height) >> 1;
    while (stride >= 1) {
      stepMat.uniforms.uPrev.value = src.texture;
      stepMat.uniforms.uStride.value = stride;
      renderer.setRenderTarget(dst);
      renderer.render(fsScene, fsCam);
      [src, dst] = [dst, src];
      stride = stride >> 1;
    }
    // Final +1 stride pass
    stepMat.uniforms.uPrev.value = src.texture;
    stepMat.uniforms.uStride.value = 1;
    renderer.setRenderTarget(dst);
    renderer.render(fsScene, fsCam);
    [src, dst] = [dst, src];

    seedRTs.push(src); // src now holds the final flood
    seedMat.dispose();
    stepMat.dispose();
    if (dst) dst.dispose();
  }

  // Resolve into RGBA distance texture
  const distRT = makeRT(width, height);
  const resolveMat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: jfaResolveFrag,
    uniforms: {
      uSeedA: { value: seedRTs[0]?.texture ?? null },
      uSeedB: { value: seedRTs[1]?.texture ?? null },
      uSeedC: { value: seedRTs[2]?.texture ?? null },
      uSeedD: { value: seedRTs[3]?.texture ?? null },
      uActiveCount: { value: top4.filter((t) => !!t).length },
      uMapSize: { value: new THREE.Vector2(width, height) },
    },
  });
  quad.material = resolveMat;
  renderer.setRenderTarget(distRT);
  renderer.render(fsScene, fsCam);

  // Gradient pass
  const gradRT = makeRT(width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  const gradMat = new THREE.ShaderMaterial({
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: jfaGradFrag,
    uniforms: {
      uDist: { value: distRT.texture },
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
    },
  });
  quad.material = gradMat;
  renderer.setRenderTarget(gradRT);
  renderer.render(fsScene, fsCam);

  renderer.setRenderTarget(null);

  // Cleanup intermediates (we keep distRT and gradRT)
  for (const rt of seedRTs) if (rt) rt.dispose();
  resolveMat.dispose();
  gradMat.dispose();
  geom.dispose();
  terrainTex.dispose();

  return {
    distance: distRT.texture,
    gradient: gradRT.texture,
    channelTerrains: top4,
    coverage: coverage as Record<TerrainId, number>,
    width,
    height,
    dispose() {
      distRT.dispose();
      gradRT.dispose();
    },
  };
}
