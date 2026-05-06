import * as THREE from "three";
import type { TerrainId } from "../core/types";
import { TerrainCatalog } from "../terrain/catalog";

export interface SplatInputs {
  distance: THREE.Texture;
  gradient: THREE.Texture;
  channelTerrains: (TerrainId | null)[];
  textures: Record<string, THREE.Texture>;
}

const SNOISE = /* glsl */ `
  vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
  vec2 mod289(vec2 x){return x - floor(x*(1.0/289.0))*289.0;}
  vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
  float snoise(vec2 v){
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                       -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                     + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
`;

/** Patch a MeshStandardMaterial via onBeforeCompile to do the SDF-softmin splat with vector-field warp. */
export function makeSplatMaterial(inputs: SplatInputs): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0.0 });

  // Resolve channel textures + tints. Default to grass if no terrain bound to a channel.
  const fallback = inputs.textures.grass;
  const tex0 = inputs.channelTerrains[0] ? inputs.textures[TerrainCatalog.get(inputs.channelTerrains[0]!).baseTextureKey] : fallback;
  const tex1 = inputs.channelTerrains[1] ? inputs.textures[TerrainCatalog.get(inputs.channelTerrains[1]!).baseTextureKey] : fallback;
  const tex2 = inputs.channelTerrains[2] ? inputs.textures[TerrainCatalog.get(inputs.channelTerrains[2]!).baseTextureKey] : fallback;
  const tex3 = inputs.channelTerrains[3] ? inputs.textures[TerrainCatalog.get(inputs.channelTerrains[3]!).baseTextureKey] : fallback;

  function tintOf(idx: number): THREE.Vector3 {
    const t = inputs.channelTerrains[idx];
    const tint = t ? TerrainCatalog.get(t).tint : [1, 1, 1];
    return new THREE.Vector3(tint[0], tint[1], tint[2]);
  }

  const uniforms = {
    uDistanceField: { value: inputs.distance },
    uBoundaryField: { value: inputs.gradient },
    uTex0: { value: tex0 },
    uTex1: { value: tex1 },
    uTex2: { value: tex2 },
    uTex3: { value: tex3 },
    uTint0: { value: tintOf(0) },
    uTint1: { value: tintOf(1) },
    uTint2: { value: tintOf(2) },
    uTint3: { value: tintOf(3) },
    uActiveCount: { value: inputs.channelTerrains.filter((t) => !!t).length },
    uTile: { value: 12.0 },
    uSharpness: { value: 0.18 },
    uWarpAmt: { value: 0.05 },
    uNoiseScale: { value: 12.0 },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>
       uniform sampler2D uDistanceField;
       uniform sampler2D uBoundaryField;
       uniform sampler2D uTex0;
       uniform sampler2D uTex1;
       uniform sampler2D uTex2;
       uniform sampler2D uTex3;
       uniform vec3 uTint0; uniform vec3 uTint1; uniform vec3 uTint2; uniform vec3 uTint3;
       uniform float uActiveCount;
       uniform float uTile;
       uniform float uSharpness;
       uniform float uWarpAmt;
       uniform float uNoiseScale;
       ${SNOISE}
      `,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `
        vec4 d = texture2D(uDistanceField, vMapUv);
        // Soft-min weights: smaller distance => higher weight.
        vec4 w = exp(-d * uSharpness);
        // Disable inactive channels:
        if (uActiveCount < 3.5) w.a = 0.0;
        if (uActiveCount < 2.5) w.b = 0.0;
        if (uActiveCount < 1.5) w.g = 0.0;
        float wsum = max(dot(w, vec4(1.0)), 1e-6);
        w /= wsum;

        vec2 g = texture2D(uBoundaryField, vMapUv).rg - vec2(0.5);
        vec2 perp = vec2(-g.y, g.x);
        float n = snoise(vMapUv * uNoiseScale);
        vec2 warpedUv = vMapUv * uTile + perp * n * uWarpAmt * uTile;

        vec3 c0 = texture2D(uTex0, warpedUv).rgb * uTint0;
        vec3 c1 = texture2D(uTex1, warpedUv).rgb * uTint1;
        vec3 c2 = texture2D(uTex2, warpedUv).rgb * uTint2;
        vec3 c3 = texture2D(uTex3, warpedUv).rgb * uTint3;
        vec3 albedo = w.r * c0 + w.g * c1 + w.b * c2 + w.a * c3;
        diffuseColor.rgb *= albedo;
      `,
    );
  };

  // Make the customProgramCacheKey unique so we don't share a cached program with vanilla MeshStandardMaterial.
  mat.customProgramCacheKey = () => "splat-jfa-v1";
  return mat;
}
