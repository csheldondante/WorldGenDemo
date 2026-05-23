import { readBuffer, writeBuffer } from "../runtime/buffer";
import { startLoop } from "../runtime/loop";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../buffers/stateMachine";
import type { RuntimeEvent } from "../runtime/stateMachine";
import type { ControllerBinding } from "../runtime/moduleSlots";
import { applyControllerBinding } from "../runtime/controllerParams";
import { TIMING_BUFFER_ID, type TimingBufferData } from "../buffers/timing";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../buffers/worldData";
import { BUILDER_BUFFER_ID, type BuilderBufferData } from "../buffers/builder";
import {
  attachInputListeners,
  createAccumulator,
  createInputSystem,
  type InputAccumulator,
} from "../systems/input";
import { attachBuilderListeners } from "../systems/builderInput";
import { resetInputRecording, type InputRecordingState } from "../systems/testing/inputRecording";
import type { Registry } from "../runtime/registry";
import type { SystemDescriptor } from "../runtime/system";
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

  // 1. Library Viewer overlay panel — visible when activeMode === "LibraryViewer".
  //    The mode-renderer writes formatted HTML into this element each tick the
  //    mode is active. Hidden by default; mode-cycling UI toggles visibility.
  const libraryViewerPanel = document.createElement("div");
  libraryViewerPanel.id = "library-viewer-panel";
  libraryViewerPanel.style.cssText = [
    "position:absolute",
    "top:48px",
    "left:8px",
    "right:8px",
    "bottom:8px",
    "padding:12px 16px",
    "background:rgba(10,12,16,0.95)",
    "color:#dadce0",
    "border:1px solid #333",
    "border-radius:6px",
    "font: 12px/1.4 system-ui, sans-serif",
    "overflow:auto",
    "z-index:60",
    "display:none",
  ].join(";");
  opts.panelEl.appendChild(libraryViewerPanel);

  // 2. Configurable runtime bootstrap (same factory the scenario harness uses
  //    in --play mode). Wires registry + core buffers/systems/graphs + Three.js
  //    handles + initial scene load via the LoadRequested event. Also registers
  //    scene modes + LibraryViewer mode for the cycling UI.
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
    libraryViewerTarget: libraryViewerPanel,
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

  // 4. Top-bar with scenario selector — visible in normal play so the user
  // can jump straight to a scenario without manually typing the URL param.
  attachTopMenu(opts.panelEl, { mode: "normal" });

  // 4b. Mode-cycling widget (= scene picker + library-viewer toggle).
  //     Dispatches LoadRequested for scene modes; flips activeMode for
  //     LibraryViewer. See docs/modes-and-modules.md for the architecture.
  attachModeSwitcher(opts.panelEl, {
    registry: reg,
    emit: app.emit,
    libraryViewerPanel,
    characterBindings: app.characterBindings,
  });

  // 5. Start the runtime loop.
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

  // Live DOM input accumulator. Listeners attached unconditionally so the
  // accumulator is current whenever the user clicks "play" — at that point
  // we just swap the registered inputSystem (via `reg.replaceSystem`) to a
  // real-DOM inputSystem reading from this accumulator. Pointer lock is
  // requested on canvas click by attachInputListeners.
  const liveAccumulator = createAccumulator();
  attachInputListeners(liveAccumulator, { pointerLockTarget: canvas });

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
  const recordingState = app.coreSystems.inputRecordingState;
  const scenarioInputSystem = test.inputSystem;

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

  attachTopMenu(opts.panelEl, {
    mode: "scenario",
    scenarioName: test.name,
    registry: reg,
    liveAccumulator,
    scenarioInputSystem,
    recordingState,
  });

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
 * Top-of-panel banner shown in both normal play and scenario playback.
 *
 * In NORMAL play: dropdown picks a scenario; selecting one navigates to
 * `?scenario=<name>`. No play/record buttons (input is already real).
 *
 * In SCENARIO playback: dropdown still works, plus three buttons:
 *   ▶ play     — flips the input override to "real DOM" so the user
 *                drives the player with their own keyboard + mouse.
 *                The scenario's simulated input is paused; the user
 *                can return to playback by reloading.
 *   ⏺ record   — like play, plus arms the input recording system to
 *                capture the takeover into an InputRecording. The
 *                recording auto-stops at frameCap (default 1800 = ~30s
 *                @ 60 Hz), or on Esc / Stop, whichever comes first.
 *   ⏹ stop     — only shown while recording; ends + dumps JSON to
 *                console. Esc has the same effect anywhere on the page.
 *
 * Lightweight DOM. Pointer-lock is requested on canvas click (already
 * wired by attachInputListeners), so the user gets mouse-look once they
 * click into the scene.
 */
/**
 * Mode-switcher widget. Sibling of the top-menu / scenario picker.
 *
 *   * Scene dropdown (left): list of all scenes registered as Modes
 *     via `registerSceneModes(SCENE_CATALOG)`. Selecting an entry
 *     dispatches a `LoadRequested` event with the scene name → the
 *     existing SM machinery transitions Loading → Rebuilding →
 *     Running. The activeMode follows the SM (= "Running").
 *   * Library Viewer toggle (right): writes `activeMode` directly to
 *     "LibraryViewer" to overlay the registry panel. Toggling back
 *     reverts to "Running" — gameplay simulation resumes.
 */
interface ModeSwitcherOptions {
  registry: Registry;
  emit: (event: RuntimeEvent) => void;
  libraryViewerPanel: HTMLElement;
  characterBindings: ControllerBinding[];
}

function attachModeSwitcher(panelEl: HTMLElement, opts: ModeSwitcherOptions): void {
  const bar = document.createElement("div");
  bar.style.cssText = [
    "position:absolute",
    "top:48px",
    "right:8px",
    "background:rgba(10,12,16,0.85)",
    "color:#dadce0",
    "padding:6px 10px",
    "border:1px solid #333",
    "border-radius:6px",
    "font: 12px/1.4 system-ui, sans-serif",
    "z-index:55",
    "display:flex",
    "gap:8px",
    "align-items:center",
    "pointer-events:auto",
  ].join(";");

  const sceneLabel = document.createElement("span");
  sceneLabel.textContent = "scene:";
  sceneLabel.style.color = "#888";
  bar.appendChild(sceneLabel);

  const sceneSelect = document.createElement("select");
  sceneSelect.style.cssText = "background:#1a2030;color:#dadce0;border:1px solid #444;padding:2px 6px;font:inherit;border-radius:3px;cursor:pointer";
  const sceneModes = opts.registry.listModes({ tags: ["scene"] }).sort((a, b) => a.label.localeCompare(b.label));
  for (const m of sceneModes) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    sceneSelect.appendChild(opt);
  }
  // Default to whatever the URL ?map= said (or canyon-desert fallback).
  const initialScene = new URL(location.href).searchParams.get("map") ?? "canyon-desert";
  sceneSelect.value = initialScene;
  sceneSelect.addEventListener("change", () => {
    opts.emit({ type: "LoadRequested", payload: { sceneName: sceneSelect.value } });
    // Reflect in URL so a refresh keeps the choice.
    const u = new URL(location.href);
    u.searchParams.set("map", sceneSelect.value);
    history.replaceState({}, "", u.toString());
  });
  bar.appendChild(sceneSelect);

  const sep = document.createElement("span");
  sep.textContent = "│";
  sep.style.color = "#444";
  bar.appendChild(sep);

  // Character binding picker — paramOverrides per binding produce
  // different "feel" (standard / agile / heavy). Phase 5; current
  // biped systems don't yet consume ControllerParamsBuffer so the
  // swap is data-only — visible behavior change lands in Phase 5b.
  const bindingLabel = document.createElement("span");
  bindingLabel.textContent = "binding:";
  bindingLabel.style.color = "#888";
  bar.appendChild(bindingLabel);
  const bindingSelect = document.createElement("select");
  bindingSelect.style.cssText = "background:#1a2030;color:#dadce0;border:1px solid #444;padding:2px 6px;font:inherit;border-radius:3px;cursor:pointer";
  for (const b of opts.characterBindings) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = b.id.replace(/^biped:/, "");
    bindingSelect.appendChild(opt);
  }
  bindingSelect.addEventListener("change", () => {
    const chosen = opts.characterBindings.find((b) => b.id === bindingSelect.value);
    if (chosen) applyControllerBinding(opts.registry, chosen);
  });
  bar.appendChild(bindingSelect);

  const sep2 = document.createElement("span");
  sep2.textContent = "│";
  sep2.style.color = "#444";
  bar.appendChild(sep2);

  // Library Viewer toggle. Directly writes activeMode (bypassing the SM)
  // so the inspector can overlay any active gameplay mode. Click again
  // (or press F1) to return to whatever mode the SM thinks is active.
  const libBtn = document.createElement("button");
  libBtn.textContent = "📚 inspect (F1)";
  libBtn.style.cssText = "background:#2c4a78;color:#fff;border:1px solid #444;padding:2px 8px;font:inherit;border-radius:3px;cursor:pointer";
  let libraryActive = false;
  function setLibraryActive(active: boolean) {
    libraryActive = active;
    const sm = opts.registry.getBuffer<StateMachineBufferData>("stateMachine");
    if (libraryActive) {
      writeBuffer(sm, (d) => { d.activeMode = "LibraryViewer"; });
      opts.libraryViewerPanel.style.display = "block";
      libBtn.style.background = "#5a8";
      libBtn.textContent = "📚 close (F1)";
    } else {
      writeBuffer(sm, (d) => { d.activeMode = d.activeGraph; });
      opts.libraryViewerPanel.style.display = "none";
      libBtn.style.background = "#2c4a78";
      libBtn.textContent = "📚 inspect (F1)";
    }
  }
  libBtn.addEventListener("click", () => setLibraryActive(!libraryActive));
  // F1 hotkey — toggles the inspector overlay. Captured at window level so
  // it works even when the canvas has pointer lock.
  window.addEventListener("keydown", (e) => {
    if (e.key === "F1") {
      e.preventDefault();
      setLibraryActive(!libraryActive);
    }
  });
  bar.appendChild(libBtn);

  panelEl.appendChild(bar);
}

interface TopMenuOptions {
  mode: "normal" | "scenario";
  scenarioName?: string;
  /** Registry — used to swap the active inputSystem when the user clicks play/record. */
  registry?: Registry;
  /** Live DOM accumulator (always collecting). The real inputSystem reads from this. */
  liveAccumulator?: InputAccumulator;
  /** The scenario's original inputSystem; we swap back to it when the user "stops" without recording. */
  scenarioInputSystem?: SystemDescriptor;
  /** State for the always-registered InputRecordingSystem. We toggle .active and reset to start. */
  recordingState?: InputRecordingState;
}

function attachTopMenu(panelEl: HTMLElement, opts: TopMenuOptions): void {
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
  label.textContent = opts.mode === "scenario" ? "scenario:" : "play:";
  label.style.color = "#888";
  bar.appendChild(label);

  const select = document.createElement("select");
  select.style.cssText = "background:#1a2030;color:#dadce0;border:1px solid #444;padding:2px 6px;font:inherit;border-radius:3px;cursor:pointer";
  if (opts.mode === "normal") {
    const optNormal = document.createElement("option");
    optNormal.value = "";
    optNormal.textContent = "(normal play)";
    optNormal.selected = true;
    select.appendChild(optNormal);
  }
  for (const name of Object.keys(SCENARIOS).sort()) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (opts.mode === "scenario" && name === opts.scenarioName) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    const next = new URL(location.href);
    if (select.value === "") next.searchParams.delete("scenario");
    else next.searchParams.set("scenario", select.value);
    location.href = next.toString();
  });
  bar.appendChild(select);

  if (opts.mode === "scenario") {
    const playNormal = document.createElement("a");
    playNormal.href = location.pathname;
    playNormal.textContent = "← play normal";
    playNormal.style.cssText = "color:#7ab; text-decoration:none";
    playNormal.addEventListener("mouseenter", () => { playNormal.style.textDecoration = "underline"; });
    playNormal.addEventListener("mouseleave", () => { playNormal.style.textDecoration = "none"; });
    bar.appendChild(playNormal);
  }

  if (
    opts.mode === "scenario" &&
    opts.registry && opts.liveAccumulator && opts.recordingState && opts.scenarioInputSystem
  ) {
    const sep = document.createElement("span");
    sep.textContent = "│";
    sep.style.color = "#444";
    bar.appendChild(sep);

    const status = document.createElement("span");
    status.textContent = "▶ playback";
    status.style.color = "#9b9";
    bar.appendChild(status);

    function makeBtn(text: string, bg: string): HTMLButtonElement {
      const b = document.createElement("button");
      b.textContent = text;
      b.style.cssText = `background:${bg};color:#fff;border:1px solid #444;padding:2px 8px;font:inherit;border-radius:3px;cursor:pointer`;
      return b;
    }
    const playBtn = makeBtn("▶ play", "#2a4");
    const recBtn = makeBtn("⏺ record", "#a33");
    const stopBtn = makeBtn("⏹ stop", "#666");
    stopBtn.style.display = "none";
    bar.appendChild(playBtn);
    bar.appendChild(recBtn);
    bar.appendChild(stopBtn);

    const reg = opts.registry;
    const liveAcc = opts.liveAccumulator;
    const recording = opts.recordingState;
    const scenarioInput = opts.scenarioInputSystem;
    // The live inputSystem is constructed once and reused across swaps.
    const liveInput = createInputSystem(liveAcc);
    let currentMode: "playback" | "live" = "playback";

    function setStatus(text: string, color: string): void {
      status.textContent = text;
      status.style.color = color;
    }
    function swapToLive(): void {
      if (currentMode === "live") return;
      reg.replaceSystem(liveInput);
      currentMode = "live";
    }
    function swapToPlayback(): void {
      if (currentMode === "playback") return;
      reg.replaceSystem(scenarioInput);
      currentMode = "playback";
    }

    function startFreePlay(): void {
      swapToLive();
      setStatus("● live input", "#fa3");
      playBtn.style.display = "none";
      recBtn.style.display = "none";
      stopBtn.style.display = "";
      stopBtn.textContent = "⏹ back to playback";
    }
    function startRecording(): void {
      swapToLive();
      resetInputRecording(recording);
      recording.active = true;
      setStatus(`⏺ recording 0/${recording.frameCap}`, "#f44");
      playBtn.style.display = "none";
      recBtn.style.display = "none";
      stopBtn.style.display = "";
      stopBtn.textContent = "⏹ stop + dump";
    }
    function stop(): void {
      const wasRecording = recording.active;
      recording.active = false;
      swapToPlayback();
      if (wasRecording) {
        const blob = JSON.stringify(recording.recording, null, 2);
        // eslint-disable-next-line no-console
        console.log(`[record] scenario=${opts.scenarioName} frames=${recording.cursor}/${recording.frameCap} events=${recording.recording.events.length}`);
        // eslint-disable-next-line no-console
        console.log(blob);
        setStatus(`saved ${recording.cursor}f → console`, "#9d9");
      } else {
        setStatus("▶ playback", "#9b9");
      }
      playBtn.style.display = "";
      recBtn.style.display = "";
      stopBtn.style.display = "none";
    }

    playBtn.addEventListener("click", startFreePlay);
    recBtn.addEventListener("click", startRecording);
    stopBtn.addEventListener("click", stop);
    window.addEventListener("keydown", (e) => {
      if (e.code === "Escape" && (currentMode === "live" || recording.active)) {
        e.preventDefault();
        stop();
      }
    });

    // Live status: update the frame counter while recording. rAF-driven so
    // it doesn't add per-tick work to the runtime loop.
    function tickStatus() {
      if (recording.active) {
        setStatus(`⏺ recording ${recording.cursor}/${recording.frameCap}`, "#f44");
        if (recording.cursor >= recording.frameCap) {
          // Recording system auto-stopped at cap; mirror UI + swap back.
          stop();
        }
      }
      requestAnimationFrame(tickStatus);
    }
    requestAnimationFrame(tickStatus);
  }

  panelEl.appendChild(bar);
}

