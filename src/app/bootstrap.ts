/**
 * Configurable runtime bootstrap. Same architecture as the real game — same
 * registry, same core systems, same graphs — parameterized so the scenario
 * harness can use it directly. The only knobs are which input source feeds
 * `InputBuffer` (real DOM, recorded playback, simulated random-walk) and
 * whether to wire Three.js / DOM handles (headless tests skip rendering).
 *
 * `startWorld()` in `src/app/world.ts` is now a thin wrapper around
 * `bootstrapApp({ inputSystem: undefined, rendering: <real handles> })`.
 * Scenarios call this with their own input system + (optionally) real
 * rendering when `--play` mode wants to show the test in a browser.
 */
import * as THREE from "three";
import { createRegistry, type Registry } from "../runtime/registry";
import { writeBuffer } from "../runtime/buffer";
import { registerCoreBuffers, type RuntimeEvent } from "../buffers";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { EVENT_BUFFER_ID } from "../buffers/event";
import { registerCoreSystems, type CoreSystems } from "../systems";
import type { SystemDescriptor } from "../runtime/system";
import { buildAndRegisterCoreGraphs } from "./graphs";

/** Three.js + DOM handles for a rendered runtime. Pass to `bootstrapApp.rendering`. */
export interface RenderingHandles {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  panelEl: HTMLElement;
  hudEl: HTMLElement;
  hintEl: HTMLElement;
  aspect?: number; // initial aspect; defaults to panel client size
}

export interface BootstrapOptions {
  /** Override the input source — pass `createInputPlaybackSystem(...)`,
   *  `createSimulatedInputSystem(...)`, etc. Defaults to real DOM/gamepad input. */
  inputSystem?: SystemDescriptor;
  /** Three.js + DOM handles. Omit for headless (no rendering). */
  rendering?: RenderingHandles;
  /** Scene to load on bootstrap. Emits a `LoadRequested` event for this name.
   *  Defaults to "canyon-desert". Pass `null` to skip the initial load. */
  sceneName?: string | null;
}

export interface AppHandle {
  registry: Registry;
  /** Shared handles registerCoreSystems returns — input accumulator (only useful
   *  when real input system is wired), builder accumulator + DOM. */
  coreSystems: CoreSystems;
  /** Emit a runtime event. The state machine processes it on the next tick. */
  emit(event: RuntimeEvent): void;
}

const DEFAULT_SCENE = "canyon-desert";

/**
 * Build the registry, register core buffers + systems + graphs, optionally
 * wire rendering, and queue the initial LoadRequested.
 *
 * Does NOT start a loop — caller chooses `startLoop(reg)` for browser play
 * mode or `executeGraph(...)` per-tick for headless harness ticks.
 */
export function bootstrapApp(options: BootstrapOptions = {}): AppHandle {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  const coreSystems = registerCoreSystems(reg, { inputSystem: options.inputSystem });
  buildAndRegisterCoreGraphs(reg); // validates: throws if any contract is violated

  if (options.rendering) {
    const r = options.rendering;
    const refs = reg.getBuffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID);
    writeBuffer(refs, (d) => {
      d.renderer = r.renderer;
      d.scene = r.scene;
      d.threeCamera = new THREE.PerspectiveCamera(70, 1, 0.1, 800);
      d.canvas = r.canvas;
      d.panelEl = r.panelEl;
      d.hudEl = r.hudEl;
      d.hintEl = r.hintEl;
    });
    const cam = reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID);
    const aspect = r.aspect ?? (r.panelEl.clientWidth || 1) / (r.panelEl.clientHeight || 1);
    writeBuffer(cam, (d) => { d.aspect = aspect; });
  }

  const sceneName = options.sceneName === null
    ? null
    : options.sceneName ?? DEFAULT_SCENE;
  if (sceneName !== null) {
    const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
    writeBuffer(events, (d) => {
      d.push({ type: "LoadRequested", payload: { sceneName } });
    });
  }

  return {
    registry: reg,
    coreSystems,
    emit(event) {
      const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
      writeBuffer(events, (d) => { d.push(event); });
    },
  };
}
