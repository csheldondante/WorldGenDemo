import * as THREE from "three";
import { createRegistry } from "../runtime/registry";
import { writeBuffer } from "../runtime/buffer";
import { startLoop } from "../runtime/loop";
import { registerCoreBuffers, type RuntimeEvent } from "../buffers";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { EVENT_BUFFER_ID } from "../buffers/event";
import { registerCoreSystems } from "../systems";
import { attachInputListeners } from "../systems/input";
import { buildAndRegisterCoreGraphs } from "./graphs";
import { createSceneBundle } from "../render/scene";
import { loadScene } from "../map/loadScene";

export interface WorldOptions {
  hudEl: HTMLElement;
  hintEl: HTMLElement;
  panelEl: HTMLElement;
}

export async function startWorld(opts: WorldOptions) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; display:block;";
  opts.panelEl.insertBefore(canvas, opts.panelEl.firstChild);

  const { scene, renderer } = createSceneBundle(canvas);

  // 1. Registry + core buffers + core systems + graphs
  const reg = createRegistry();
  registerCoreBuffers(reg);
  const { inputAccumulator } = registerCoreSystems(reg);
  buildAndRegisterCoreGraphs(reg); // validates: throws if any contract is violated

  // 2. Wire RenderRefsBuffer with concrete Three.js handles + DOM refs
  const refs = reg.getBuffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID);
  writeBuffer(refs, (d) => {
    d.renderer = renderer;
    d.scene = scene;
    // We use a fresh PerspectiveCamera owned by the runtime; RenderSystem mirrors the buffer into it.
    d.threeCamera = new THREE.PerspectiveCamera(70, 1, 0.1, 800);
    d.canvas = canvas;
    d.panelEl = opts.panelEl;
    d.hudEl = opts.hudEl;
    d.hintEl = opts.hintEl;
  });

  // 3. Sync camera aspect to viewport, observe panel resize
  const cam = reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID);
  function applyResize() {
    const w = opts.panelEl.clientWidth || innerWidth;
    const h = opts.panelEl.clientHeight || innerHeight;
    writeBuffer(cam, (d) => { d.aspect = w / h; });
    renderer.setSize(w, h, false);
  }
  applyResize();
  window.addEventListener("resize", applyResize);
  new ResizeObserver(applyResize).observe(opts.panelEl);

  // 4. DOM input listeners feed the accumulator (handles click → pointer-lock)
  attachInputListeners(inputAccumulator, { pointerLockTarget: canvas });
  document.addEventListener("pointerlockchange", () => {
    opts.hintEl.classList.toggle("hidden", !!document.pointerLockElement);
  });

  // 5. Bootstrap initial scene: fetch + emit RebuildRequested
  const url = new URL(location.href);
  const sceneName = url.searchParams.get("map") ?? "canyon-desert";
  try {
    const loaded = await loadScene(sceneName);
    const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
    writeBuffer(events, (d) => {
      d.push({
        type: "RebuildRequested",
        payload: {
          sceneName,
          pixels: extractPixels(loaded.image, loaded.labelMap.width, loaded.labelMap.height),
          width: loaded.labelMap.width,
          height: loaded.labelMap.height,
          scene: loaded.scene,
          image: loaded.image,
        },
      });
    });
  } catch (err) {
    console.error("initial scene load failed", err);
    opts.hudEl.textContent = `error: ${(err as Error).message}\n(see console)`;
  }

  // 6. Start the runtime loop. It picks the activeGraph from StateMachineBuffer each tick.
  startLoop(reg);
}

function extractPixels(image: HTMLImageElement, w: number, h: number): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}
