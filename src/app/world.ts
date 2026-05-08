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

export interface WorldOptions {
  hudEl: HTMLElement;
  hintEl: HTMLElement;
  panelEl: HTMLElement;
}

export function startWorld(opts: WorldOptions): void {
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

  // 5. Kick off the initial scene load by emitting a LoadRequested event.
  //    The SM is initially in "Loading" state; LoadSceneSystem owns the fetch
  //    and emits RebuildRequested when the bytes arrive. The runtime loop runs
  //    immediately so the HUD updates from tick 1.
  const url = new URL(location.href);
  const sceneName = url.searchParams.get("map") ?? "canyon-desert";
  const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
  writeBuffer(events, (d) => {
    d.push({ type: "LoadRequested", payload: { sceneName } });
  });

  // 6. Start the runtime loop — picks activeGraph from StateMachineBuffer each tick.
  startLoop(reg);
}
