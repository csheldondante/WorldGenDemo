/**
 * Render-only backdrop helpers for scenario playback.
 *
 * `BufferTest.backdrop` declares visual references the human needs to validate
 * a scenario by eye. None of it touches the test physics — `runBufferTest`
 * ignores `backdrop` entirely. Browser playback (`startScenarioWorld`) applies
 * it after seeding so the WebGL canvas shows a recognizable world.
 *
 * What gets generated:
 *   - `surfaceDebugMesh: true` — sample the active SurfaceProvider on a UV
 *     grid, build a triangulated wireframe mesh, add to the scene. Works for
 *     any provider (plane, heightmap, cylinder, torus).
 *   - `axisGizmo: true` (or `{ at, size }`) — small XYZ red/green/blue axis
 *     lines at the given world point. Default at origin, size 5m.
 *
 * Both are conservative: no shading tricks, no lighting changes. Just the
 * minimum the user needs to tell "where am I, which way am I facing, is the
 * surface where I expected it to be."
 */
import * as THREE from "three";
import type { Registry } from "../runtime/registry";
import { readBuffer } from "../runtime/buffer";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../buffers/surfaceProvider";

export interface ScenarioBackdrop {
  /** When true, build a wireframe surface mesh from the active SurfaceProvider. */
  surfaceDebugMesh?: boolean;
  /** When set, add a small XYZ axis gizmo. `true` ≡ default origin + size 5m. */
  axisGizmo?: boolean | { at?: [number, number, number]; size?: number };
  /**
   * UV grid resolution for `surfaceDebugMesh`. Default 32 across each axis;
   * heightmaps with a lot of detail look better at 64. Higher = slower load.
   */
  surfaceMeshResolution?: number;
}

/**
 * Apply backdrop data to the Three.js scene. Called by `startScenarioWorld`
 * once, after the scenario's seed has populated buffers.
 */
export function applyScenarioBackdrop(
  scene: THREE.Scene,
  reg: Registry,
  backdrop: ScenarioBackdrop | undefined,
): void {
  if (!backdrop) return;

  if (backdrop.surfaceDebugMesh) {
    const sp = readBuffer(reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID));
    const provider = sp.heightmap;
    if (provider) {
      const mesh = buildSurfaceWireframeMesh(provider, backdrop.surfaceMeshResolution ?? 32);
      scene.add(mesh);
    } else {
      // No surface set — log so the user knows the scenario didn't seed one.
      console.warn("[backdrop] surfaceDebugMesh requested but SurfaceProviderBuffer is empty");
    }
  }

  if (backdrop.axisGizmo) {
    const cfg = typeof backdrop.axisGizmo === "object" ? backdrop.axisGizmo : {};
    scene.add(buildAxisGizmo(cfg.at ?? [0, 0, 0], cfg.size ?? 5));
  }
}

/**
 * Triangulated wireframe mesh for any SurfaceProvider. Samples positions on a
 * (resolution+1)×(resolution+1) UV grid; emits one BufferGeometry with line
 * segments along the grid (so it stays cheap and readable). Closed surfaces
 * (cylinders, tori) get the seam segment too.
 */
function buildSurfaceWireframeMesh(
  provider: { sampleAtUV(u: number, v: number): { position: [number, number, number] }; wrapsU?: () => boolean; wrapsV?: () => boolean },
  resolution: number,
): THREE.Object3D {
  const N = Math.max(2, resolution);
  const wrapsU = provider.wrapsU?.() ?? false;
  const wrapsV = provider.wrapsV?.() ?? false;
  // Sample positions on the grid.
  const positions: number[][] = [];
  for (let j = 0; j <= N; j++) {
    const row: number[] = [];
    for (let i = 0; i <= N; i++) {
      const u = wrapsU ? (i / N) % 1 : i / N;
      const v = wrapsV ? (j / N) % 1 : j / N;
      const p = provider.sampleAtUV(u, v).position;
      row.push(p[0], p[1], p[2]);
    }
    positions.push(row);
  }

  // Build line segments along constant-u and constant-v.
  const segments: number[] = [];
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i < N; i++) {
      // along u
      segments.push(
        positions[j][i * 3],     positions[j][i * 3 + 1],     positions[j][i * 3 + 2],
        positions[j][(i + 1) * 3], positions[j][(i + 1) * 3 + 1], positions[j][(i + 1) * 3 + 2],
      );
    }
  }
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j < N; j++) {
      // along v
      segments.push(
        positions[j][i * 3],     positions[j][i * 3 + 1],     positions[j][i * 3 + 2],
        positions[j + 1][i * 3], positions[j + 1][i * 3 + 1], positions[j + 1][i * 3 + 2],
      );
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(segments, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x4a8cc8, transparent: true, opacity: 0.75 });
  const lines = new THREE.LineSegments(geom, mat);
  lines.name = "scenarioBackdrop_surfaceWireframe";
  lines.frustumCulled = false;
  return lines;
}

/**
 * Three axis-aligned line segments: +X red, +Y green, +Z blue. Marks an origin
 * point so yaw/pitch are visible without world geometry.
 */
function buildAxisGizmo(at: [number, number, number], size: number): THREE.Object3D {
  const group = new THREE.Group();
  group.name = "scenarioBackdrop_axisGizmo";
  const make = (vec: [number, number, number], color: number): THREE.Line => {
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(at[0], at[1], at[2]),
      new THREE.Vector3(at[0] + vec[0] * size, at[1] + vec[1] * size, at[2] + vec[2] * size),
    ]);
    return new THREE.Line(geom, new THREE.LineBasicMaterial({ color }));
  };
  group.add(make([1, 0, 0], 0xff4040)); // +X red
  group.add(make([0, 1, 0], 0x40ff40)); // +Y green
  group.add(make([0, 0, 1], 0x4080ff)); // +Z blue
  group.frustumCulled = false;
  return group;
}
