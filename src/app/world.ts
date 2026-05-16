import { readBuffer, writeBuffer } from "../runtime/buffer";
import { startLoop } from "../runtime/loop";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../buffers/stateMachine";
import { TIMING_BUFFER_ID, type TimingBufferData } from "../buffers/timing";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../buffers/worldData";
import { BUILDER_BUFFER_ID, type BuilderBufferData } from "../buffers/builder";
import { attachInputListeners } from "../systems/input";
import { attachBuilderListeners } from "../systems/builderInput";
import type { RuntimeMode } from "../runtime/stateMachine";
import { createSceneBundle } from "../render/scene";
import { bootstrapApp } from "./bootstrap";
import { SCENARIOS } from "../../scenarios/index";
import { applyScenarioBackdrop } from "./scenarioBackdrop";

export interface WorldOptions {
  hudEl: HTMLElement;
  hintEl: HTMLElement;
  panelEl: HTMLElement;
  /** Optional builder panel — wired up if present so tab clicks can switch modes. */
  builderPanelEl?: HTMLElement;
}

export interface WorldHandle {
  /** Emit a ModeRequested event into the runtime. SM transitions on next tick. */
  requestMode(mode: RuntimeMode): void;
}

export function startWorld(opts: WorldOptions): WorldHandle {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; display:block;";
  opts.panelEl.insertBefore(canvas, opts.panelEl.firstChild);

  const { scene, renderer } = createSceneBundle(canvas);

  // 1. Configurable runtime bootstrap (same factory the scenario harness uses
  //    in --play mode). Wires registry + core buffers/systems/graphs + Three.js
  //    handles + initial scene load via the LoadRequested event.
  const url = new URL(location.href);
  const sceneName = url.searchParams.get("map") ?? "canyon-desert";
  const app = bootstrapApp({
    rendering: {
      scene,
      renderer,
      canvas,
      panelEl: opts.panelEl,
      hudEl: opts.hudEl,
      hintEl: opts.hintEl,
    },
    sceneName,
  });
  const reg = app.registry;
  const { inputAccumulator, builderAccumulator, builderDom } = app.coreSystems;

  // 2. Sync camera aspect to viewport; observe panel resize.
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

  // 3. DOM input listeners feed the accumulator (handles click → pointer-lock).
  attachInputListeners(inputAccumulator, { pointerLockTarget: canvas });
  document.addEventListener("pointerlockchange", () => {
    opts.hintEl.classList.toggle("hidden", !!document.pointerLockElement);
  });

  // 3b. Builder DOM listeners (paint canvas, palette, asset menu, toolbar).
  if (opts.builderPanelEl) {
    attachBuilderListeners({
      panel: opts.builderPanelEl,
      acc: builderAccumulator,
      dom: builderDom,
    });
  }

  // 4. Start the runtime loop.
  startLoop(reg);

  // 7. Debug snapshot.
  (window as unknown as { __runtimeDebug?: () => unknown }).__runtimeDebug = () => {
    const sm = readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
    const refsData = readBuffer(reg.getBuffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
    const timing = readBuffer(reg.getBuffer<TimingBufferData>(TIMING_BUFFER_ID));
    const world = readBuffer(reg.getBuffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
    const builder = readBuffer(reg.getBuffer<BuilderBufferData>(BUILDER_BUFFER_ID));
    return {
      smState: sm.state,
      activeGraph: sm.activeGraph,
      pendingLoad: sm.pendingLoad,
      pendingRebuild: sm.pendingRebuild ? "<payload>" : null,
      rebuildGeneration: sm.rebuildGeneration,
      sceneName: world.sceneName,
      hasImage: !!world.image,
      hasLabelMap: !!world.labelMap,
      hasTerrainMap: !!world.terrainMap,
      hasHeightmap: !!world.heightmap,
      hasJfa: !!world.jfa,
      terrainMeshSet: !!refsData.terrainMesh,
      assetMeshCount: refsData.assetMeshes.length,
      stages: timing.stages,
      warnings: timing.warnings.slice(),
      builder: {
        bootstrapped: builder.bootstrapped,
        paletteSize: builder.palette.length,
        thumbnailCount: builder.thumbnails.size,
        bitmapSize: [builder.width, builder.height],
        activeId: builder.activeId,
        brushTool: builder.brushTool,
        historyDepth: builder.history.length,
        historyIndex: builder.historyIndex,
      },
      buffers: reg.listBuffers().map((b) => ({ id: b.id, version: b.version })),
      systems: reg.listSystems().map((s) => s.id),
      graphs: reg.listGraphs().map((g) => ({ id: g.id, order: g.order })),
    };
  };

  return {
    requestMode(mode: RuntimeMode) {
      app.emit({ type: "ModeRequested", payload: { mode } });
    },
  };
}

/**
 * Play a scenario in the browser with rendering enabled. Same bootstrap
 * as `startWorld`, but:
 *   - InputBuffer comes from the scenario's `inputSource` (playback recording
 *     or simulated generator), not from real keyboard/gamepad.
 *   - The scenario's `seed(reg)` initializes state (forces SM→Running, writes
 *     the SurfaceProviderBuffer, spawns the player), so no scene-load pipeline
 *     runs.
 *   - The render loop runs normally; the user watches the scenario play out.
 *
 * URL-routed via `?scenario=<name>` from main.ts.
 */
export function startScenarioWorld(opts: WorldOptions, scenarioName: string): WorldHandle {
  const test = SCENARIOS[scenarioName];
  if (!test) {
    throw new Error(`unknown scenario "${scenarioName}". Available: ${Object.keys(SCENARIOS).sort().join(", ")}`);
  }
  if (test.input.kind !== "seed") {
    throw new Error(`scenario "${scenarioName}" uses input.kind="${test.input.kind}" which browser play mode does not yet support`);
  }

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute; top:0; left:0; width:100%; height:100%; display:block;";
  opts.panelEl.insertBefore(canvas, opts.panelEl.firstChild);
  const { scene, renderer } = createSceneBundle(canvas);

  const app = bootstrapApp({
    inputSystem: test.inputSystem,
    rendering: {
      scene,
      renderer,
      canvas,
      panelEl: opts.panelEl,
      hudEl: opts.hudEl,
      hintEl: opts.hintEl,
    },
    sceneName: null, // scenarios seed scene state directly
  });
  test.input.fn(app.registry);
  const reg = app.registry;

  // Render-only backdrop (surface wireframe, axis gizmo). Doesn't touch test
  // physics; just gives the human something to look at during playback.
  applyScenarioBackdrop(scene, reg, test.backdrop);

  // Resize observer (same as real world).
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

  console.log(`[scenario] ${test.name}: ${test.description}`);
  const totalTicks = test.steps.reduce((a, s) => a + s.ticks, 0);
  console.log(`[scenario] steps=${test.steps.length} total-ticks=${totalTicks}`);

  attachScenarioMenu(opts.panelEl, test.name);

  // Match startWorld's __runtimeDebug surface so debugging tools work the
  // same way in scenario mode (used by the smoke harness's state.json capture).
  (window as unknown as { __runtimeDebug?: () => unknown }).__runtimeDebug = () => ({
    mode: "scenario",
    scenarioName: test.name,
    description: test.description,
    smState: readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID)).state,
    activeGraph: readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID)).activeGraph,
    totalTicks,
    buffers: reg.listBuffers().map((b) => ({ id: b.id, version: b.version })),
    systems: reg.listSystems().map((s) => s.id),
    graphs: reg.listGraphs().map((g) => ({ id: g.id, order: g.order })),
  });

  startLoop(reg);

  return {
    requestMode() { /* scenarios don't switch modes */ },
  };
}

/**
 * Top-of-panel banner shown in scenario playback mode: scenario name +
 * dropdown to switch to another scenario + a "play normal" link back to the
 * regular game. Lightweight DOM, fixed position so it doesn't fight the
 * Three.js canvas underneath.
 */
function attachScenarioMenu(panelEl: HTMLElement, currentName: string): void {
  const bar = document.createElement("div");
  bar.style.cssText = [
    "position:absolute",
    "top:8px",
    "left:50%",
    "transform:translateX(-50%)",
    "background:rgba(10,12,16,0.85)",
    "color:#dadce0",
    "padding:6px 12px",
    "border:1px solid #333",
    "border-radius:6px",
    "font: 12px/1.4 system-ui, sans-serif",
    "z-index:50",
    "display:flex",
    "gap:10px",
    "align-items:center",
    "pointer-events:auto",
  ].join(";");
  const label = document.createElement("span");
  label.textContent = "scenario:";
  label.style.color = "#888";
  bar.appendChild(label);

  const select = document.createElement("select");
  select.style.cssText = "background:#1a2030;color:#dadce0;border:1px solid #444;padding:2px 6px;font:inherit;border-radius:3px;cursor:pointer";
  for (const name of Object.keys(SCENARIOS).sort()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === currentName) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    const next = new URL(location.href);
    next.searchParams.set("scenario", select.value);
    location.href = next.toString();
  });
  bar.appendChild(select);

  const playNormal = document.createElement("a");
  playNormal.href = location.pathname; // strips ?scenario=...
  playNormal.textContent = "← play normal";
  playNormal.style.cssText = "color:#7ab; text-decoration:none";
  playNormal.addEventListener("mouseenter", () => { playNormal.style.textDecoration = "underline"; });
  playNormal.addEventListener("mouseleave", () => { playNormal.style.textDecoration = "none"; });
  bar.appendChild(playNormal);

  panelEl.appendChild(bar);
}

