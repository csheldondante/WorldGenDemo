import * as THREE from "three";
import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../../buffers/surfaceProvider";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../../buffers/renderRefs";
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../../buffers/volumeField";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID } from "../../buffers/timing";
import { STATE_MACHINE_SYSTEM_ID } from "../../runtime/stateMachine";
import { SURFACE_PROVIDER_SYSTEM_ID } from "./surfaceProvider";
import { ASSET_PLACEMENT_SYSTEM_ID } from "./assetPlacement";
import { TERRAIN_MESH_SYSTEM_ID } from "./terrainMesh";
import { RENDER_SYSTEM_ID } from "../render";
import { runOncePerRebuild } from "./common";
import {
  PlaneSurfaceProvider,
  CylindricalSurfaceProvider,
  TorusSurfaceProvider,
} from "../../world/parametricSurfaceProvider";
import { HeightmapSurfaceProvider, type SurfaceProvider } from "../../world/surfaceProvider";
import type { Heightmap } from "../../map/heightmap";
import type { ParametricSurfaceSpec, SceneFile } from "../../core/types";

export const PARAMETRIC_SURFACE_SYSTEM_ID = "parametricSurfaceSystem";

/**
 * Pipeline stage for parametric (gym) scenes. When `pendingRebuild.scene.parametric` is
 * set, builds the analytic SurfaceProvider for the spec, writes it to SurfaceProviderBuffer
 * (replacing whatever the bitmap path would have produced), and adds a visualization mesh
 * to the THREE scene so the user can see what they're running on.
 *
 * Bitmap pipeline stages (parseBitmap → splitLayers → heightmap → JFA → terrainMesh →
 * assetPlacement) early-out when scene.parametric is present, so the two paths are
 * mutually exclusive without graph reshuffling.
 *
 * Also writes `sceneName` into WorldDataBuffer so HUD and other readers find the current
 * scene (the bitmap path's parseBitmap stage does the same job for non-parametric scenes).
 */
export function createParametricSurfaceSystem(): SystemDescriptor {
  const state = { lastGen: -1 };
  return {
    id: PARAMETRIC_SURFACE_SYSTEM_ID,
    description:
      "When scene.parametric is set, builds the analytic SurfaceProvider + a visualization mesh, replaces any existing terrain mesh in the THREE scene, and writes the provider into SurfaceProviderBuffer.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "readwrite" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "write" },
      { id: RENDER_REFS_BUFFER_ID, access: "readwrite" },
      { id: VOLUME_FIELD_BUFFER_ID, access: "readwrite" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    // Replaces what surfaceProviderSystem would have written; must run AFTER it so the
    // parametric provider wins. Also runsAfter terrainMesh/assetPlacement so the timing
    // buffer's writer ordering is consistent (every pipeline writer of `timing` must
    // chain) and so we can dispose any terrainMesh those stages spawned on a previous
    // rebuild without racing.
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      SURFACE_PROVIDER_SYSTEM_ID,
      TERRAIN_MESH_SYSTEM_ID,
      ASSET_PLACEMENT_SYSTEM_ID,
    ],
    // Render reads RenderRefsBuffer; declare runsBefore to disambiguate the read/write
    // hazard cleanly from this end (and for the Rebuilding graph where the canary lives).
    runsBefore: [RENDER_SYSTEM_ID],
    execute: (ctx) => {
      runOncePerRebuild({
        ctx,
        state,
        stageName: "parametricSurface",
        body: (sm) => {
          const scene: SceneFile = sm.pendingRebuild!.scene;
          if (!scene.parametric) return; // bitmap scene — nothing to do

          const provider = buildProvider(scene.parametric);

          writeBuffer(ctx.buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID), (d) => {
            d.heightmap = provider;
          });
          writeBuffer(ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID), (d) => {
            d.sceneName = scene.name;
          });

          // Copy scene-declared gravity volumes into VolumeFieldBuffer. On rebuild we
          // replace whatever was there from a previous scene — universalGravity stays.
          // SceneFile uses JSON-friendly types (Vec3 = number[]); GravityVolume types
          // accept the same shape, so this is a pass-through copy.
          writeBuffer(ctx.buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
            d.volumes = (scene.gravityVolumes ?? []).map((v) => ({
              shape: v.shape,
              field: v.field,
              priority: v.priority,
            }));
          });

          // Visual mesh
          const refsBuf = ctx.buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID);
          const refs = readBuffer(refsBuf);
          if (!refs.scene) return;
          if (refs.terrainMesh) disposeMesh(refs.scene, refs.terrainMesh);
          const mesh = buildParametricMesh(scene.parametric, provider);
          refs.scene.add(mesh);
          writeBuffer(refsBuf, (d) => { d.terrainMesh = mesh; });
        },
      });
    },
  };
}

function buildProvider(spec: ParametricSurfaceSpec): SurfaceProvider {
  switch (spec.type) {
    case "plane":
      return new PlaneSurfaceProvider({
        id: "scene-parametric-plane",
        origin: spec.origin,
        extentU: spec.extentU,
        extentV: spec.extentV,
      });
    case "cylinder":
      return new CylindricalSurfaceProvider({
        id: "scene-parametric-cylinder",
        axisOrigin: spec.axisOrigin,
        axisDirection: spec.axisDirection,
        radius: spec.radius,
        height: spec.height,
        concave: spec.concave,
      });
    case "torus":
      return new TorusSurfaceProvider({
        id: "scene-parametric-torus",
        center: spec.center,
        axisDirection: spec.axisDirection,
        majorRadius: spec.majorRadius,
        minorRadius: spec.minorRadius,
        concave: spec.concave,
      });
    case "heightmap-bump": {
      // Synthesize a flat heightmap with a single Gaussian dome at the center.
      // World coords: HeightmapSurfaceProvider centers the patch on world origin,
      // so the apex lands at (0, peak, 0).
      const { width, height, tileSize, peak, sigma } = spec;
      const data = new Float32Array(width * height);
      // sigma is in world units (m); convert to cell units for the gaussian.
      const sigmaCells = sigma / tileSize;
      const cx = (width - 1) * 0.5;
      const cy = (height - 1) * 0.5;
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const dx = i - cx;
          const dz = j - cy;
          data[j * width + i] = peak * Math.exp(-(dx * dx + dz * dz) / (2 * sigmaCells * sigmaCells));
        }
      }
      const hm: Heightmap = { width, height, tileSize, data };
      return new HeightmapSurfaceProvider("scene-parametric-heightmap-bump", hm);
    }
    case "heightmap-mesa": {
      // Mesa: flat top of height `peak` within `topRadius` of center; smooth
      // half-cosine descent over `slopeWidth` to elevation 0; flat at 0 outside.
      // Half-cosine keeps the slope C¹ at top and bottom but the LIP has clear
      // non-zero second derivative — exactly what the centripetal rule needs.
      const { width, height, tileSize, peak, topRadius, slopeWidth } = spec;
      const data = new Float32Array(width * height);
      const cx = (width - 1) * 0.5;
      const cy = (height - 1) * 0.5;
      // Convert world distances to cell distances.
      const topR = topRadius / tileSize;
      const slopeW = slopeWidth / tileSize;
      for (let j = 0; j < height; j++) {
        for (let i = 0; i < width; i++) {
          const dx = i - cx;
          const dz = j - cy;
          const r = Math.hypot(dx, dz);
          let h: number;
          if (r <= topR) {
            h = peak;
          } else if (r >= topR + slopeW) {
            h = 0;
          } else {
            // Half-cosine descent: r=topR → peak; r=topR+slopeW → 0.
            const t = (r - topR) / slopeW;
            h = peak * 0.5 * (1 + Math.cos(Math.PI * t));
          }
          data[j * width + i] = h;
        }
      }
      const hm: Heightmap = { width, height, tileSize, data };
      return new HeightmapSurfaceProvider("scene-parametric-heightmap-mesa", hm);
    }
  }
}

function buildParametricMesh(spec: ParametricSurfaceSpec, provider: SurfaceProvider): THREE.Mesh {
  // Tessellate the surface's own sampling grid — works uniformly for all parametric types
  // and stays consistent with the SurfaceProvider math. Sample at a 32×32 (planes) or
  // 64×32 (cylinders/tori) grid; build vertex/index buffers; flat-shaded material.
  const segU = spec.type === "plane" ? 32 : 64;
  const segV = 32;
  const vertCount = (segU + 1) * (segV + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  // Cylinder / torus get visible bands so the user can see motion around the perimeter.
  // Plane / heightmap stay uniform.
  const stripeMesh = spec.type === "cylinder" || spec.type === "torus";
  // Stripe count along u (perimeter). 16 light/dark bands.
  const STRIPES_U = 16;
  // Light band: pale gray-blue. Dark band: slate. Plane / heightmap: a single light tone.
  const lightR = 0.55, lightG = 0.65, lightB = 0.75;
  const darkR  = 0.30, darkG = 0.35, darkB = 0.40;
  const uniR   = 0.55, uniG   = 0.65, uniB   = 0.75;
  for (let j = 0; j <= segV; j++) {
    for (let i = 0; i <= segU; i++) {
      const u = i / segU;
      const v = j / segV;
      const s = provider.sampleAtUV(u, v);
      const off = (j * (segU + 1) + i) * 3;
      positions[off] = s.position[0];
      positions[off + 1] = s.position[1];
      positions[off + 2] = s.position[2];
      normals[off] = s.normal[0];
      normals[off + 1] = s.normal[1];
      normals[off + 2] = s.normal[2];
      // Per-vertex color: alternating dark/light bands around u for cylinder/torus.
      let r: number, g: number, b: number;
      if (stripeMesh) {
        const band = Math.floor(u * STRIPES_U) % 2;
        if (band === 0) { r = lightR; g = lightG; b = lightB; }
        else { r = darkR; g = darkG; b = darkB; }
      } else {
        r = uniR; g = uniG; b = uniB;
      }
      colors[off] = r;
      colors[off + 1] = g;
      colors[off + 2] = b;
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * (segU + 1) + i;
      const b = a + 1;
      const c = a + (segU + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geom.setIndex(indices);
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  return new THREE.Mesh(geom, mat);
}

function disposeMesh(scene: THREE.Scene, mesh: THREE.Mesh): void {
  scene.remove(mesh);
  mesh.geometry.dispose();
  const m = mesh.material as THREE.Material | THREE.Material[];
  if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
  else m.dispose();
}
