import * as THREE from "three";
import { createBuffer, type Buffer } from "../runtime/buffer";

export interface RenderRefsBufferData {
  renderer: THREE.WebGLRenderer | null;
  scene: THREE.Scene | null;
  threeCamera: THREE.PerspectiveCamera | null;
  canvas: HTMLCanvasElement | null;
  panelEl: HTMLElement | null;
  hudEl: HTMLElement | null;
  hintEl: HTMLElement | null;
  minimapEl: HTMLElement | null;
  /** The terrain mesh currently in the scene; replaced on rebuild. */
  terrainMesh: THREE.Mesh | null;
  /** Asset meshes (instanced or per-component) currently in the scene. */
  assetMeshes: THREE.Object3D[];
}

export const RENDER_REFS_BUFFER_ID = "renderRefs";

export function createRenderRefsBuffer(): Buffer<RenderRefsBufferData> {
  return createBuffer<RenderRefsBufferData>({
    id: RENDER_REFS_BUFFER_ID,
    description: "Three.js handles + DOM refs. Three.js is a render backend; gameplay state lives in other buffers.",
    initial: {
      renderer: null,
      scene: null,
      threeCamera: null,
      canvas: null,
      panelEl: null,
      hudEl: null,
      hintEl: null,
      minimapEl: null,
      terrainMesh: null,
      assetMeshes: [],
    },
  });
}
