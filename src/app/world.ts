import { readBuffer, writeBuffer } from "../runtime/buffer";
import { startLoop } from "../runtime/loop";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../buffers/stateMachine";
import type { RuntimeEvent } from "../runtime/stateMachine";
import type { ControllerBinding } from "../runtime/moduleSlots";
import { TIMING_BUFFER_ID, type TimingBufferData } from "../buffers/timing";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../buffers/worldData";
import { BUILDER_BUFFER_ID, type BuilderBufferData } from "../buffers/builder";
import {
  attachInputListeners,
  createAccumulator,
  createInputSystem,
} from "../systems/input";
import { attachBuilderListeners } from "../systems/builderInput";
import { type InputRecordingState } from "../systems/testing/inputRecording";
import { createInputSourceSelectorSystem } from "../systems/inputSourceSelector";
import { applyProfileEdit, cloneActiveProfile, type EditableField } from "./profileEditor";
import type { Registry } from "../runtime/registry";
import type { RuntimeMode } from "../runtime/stateMachine";
import { createSceneBundle } from "../render/scene";
import { bootstrapApp } from "./bootstrap";
import { SCENARIOS } from "../../scenarios/index";
import { applyScenarioBackdrop } from "./scenarioBackdrop";

export interface WorldOptions {
  hudEl: HTMLElement;
  hintEl: HTMLElement;
  panelEl: HTMLElement;
  /** Optional builder panel — wired up if present so the mode dropdown can
   *  swap to it. Mapped to the "Builder" mode id in the panels registry. */
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
  // Attached to body (not opts.panelEl) so it overlays correctly
  // regardless of which DOM panel (.world or .builder) is active.
  libraryViewerPanel.style.cssText = [
    "position:fixed",
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
  document.body.appendChild(libraryViewerPanel);

  // Profile editor panel — sibling of the library-viewer overlay.
  // Same lifecycle (visible while activeMode === "ProfileEditor",
  // hidden otherwise — managed by OverlayVisibilitySystem).
  const profileEditorPanel = document.createElement("div");
  profileEditorPanel.id = "profile-editor-panel";
  profileEditorPanel.style.cssText = libraryViewerPanel.style.cssText;
  document.body.appendChild(profileEditorPanel);
  // Listener: form inputs (range + number) write back to the active
  // profile via applyProfileEdit. Both input + change events fire so
  // drag-during-slide + commit-on-release both work.
  function onProfileInput(e: Event) {
    const t = e.target as HTMLInputElement;
    const field = t.dataset.peField as EditableField | undefined;
    if (!field) return;
    const value = Number(t.value);
    if (!Number.isFinite(value)) return;
    applyProfileEdit(reg, field, value);
    const siblings = profileEditorPanel.querySelectorAll<HTMLInputElement>(`input[data-pe-field="${field}"]`);
    siblings.forEach((s) => { if (s !== t) s.value = String(value); });
  }
  profileEditorPanel.addEventListener("input", onProfileInput);
  profileEditorPanel.addEventListener("change", onProfileInput);
  // Clone-button click: copies the active profile into the buffer
  // under a new id + repoints the editor + live characters at it.
  profileEditorPanel.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.peAction === "clone") {
      const newId = cloneActiveProfile(reg);
      // eslint-disable-next-line no-console
      if (newId) console.log(`[profileEditor] cloned active profile → ${newId}`);
    }
  });

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
    profileEditorTarget: profileEditorPanel,
    panels: {
      world: opts.panelEl,
      builder: opts.builderPanelEl ?? null,
    },
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

  // (The old normal-mode attachTopMenu scenario picker is replaced by
  // the unified mode dropdown — scenarios appear in the "test levels"
  // optgroup of the mode dropdown. Removed 2026-05-23.)

  // 4b. Mode-cycling widget. Lives at the top of the page (document.body,
  //     position: fixed) so it's visible regardless of which DOM panel is
  //     active. Replaces the old top-tabs row in index.html — Builder /
  //     DebugGym / scenes / LibraryViewer are all just modes in the
  //     dropdown now. See docs/modes-and-modules.md.
  attachModeSwitcher({
    registry: reg,
    emit: app.emit,
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
  if (!test.inputSystem) {
    throw new Error(`scenario "${scenarioName}" has no inputSystem — browser play requires one`);
  }
  const scenarioInputSystem = test.inputSystem;
  const liveInputSystem = createInputSystem(liveAccumulator);

  // Register the input-source selector — it observes activeMode and
  // applies the matching input descriptor + recording flag. The
  // play/record/stop buttons (= attachTopMenu) now only emit
  // ModeSwitchRequested; the selector is the single place that
  // performs the imperative swap. Per user 2026-05-23: "use the
  // systems we build and patterns we build to make clean, extendable,
  // readable code with thorough tests".
  reg.registerSystem(createInputSourceSelectorSystem(reg, {
    modes: {
      ScenarioPlayback: { input: scenarioInputSystem },
      ScenarioFreePlay: { input: liveInputSystem },
      ScenarioRecording: { input: liveInputSystem, recording: true },
    },
    recordingState,
    onRecordingComplete: (state) => {
      const blob = JSON.stringify(state.recording, null, 2);
      // eslint-disable-next-line no-console
      console.log(`[record] scenario=${test.name} frames=${state.cursor}/${state.frameCap} events=${state.recording.events.length}`);
      // eslint-disable-next-line no-console
      console.log(blob);
    },
  }));

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
  characterBindings: ControllerBinding[];
}

function attachModeSwitcher(opts: ModeSwitcherOptions): void {
  const bar = document.createElement("div");
  bar.style.cssText = [
    "position:fixed",
    "top:8px",
    "right:8px",
    "background:rgba(10,12,16,0.85)",
    "color:#dadce0",
    "padding:6px 10px",
    "border:1px solid #333",
    "border-radius:6px",
    "font: 12px/1.4 system-ui, sans-serif",
    "z-index:200",
    "display:flex",
    "gap:8px",
    "align-items:center",
    "pointer-events:auto",
  ].join(";");

  // Mode dropdown — unifies what used to be the top-tabs (World / Scene
  // Builder), the scene picker, and the debug-gym affordance. The
  // dropdown's options are sourced from the registry's mode list,
  // grouped by tag (core/editor first, scene last). Selecting a mode
  // routes the right event based on the mode's kind.
  const modeLabel = document.createElement("span");
  modeLabel.textContent = "mode:";
  modeLabel.style.color = "#888";
  bar.appendChild(modeLabel);

  const modeSelect = document.createElement("select");
  modeSelect.style.cssText = "background:#1a2030;color:#dadce0;border:1px solid #444;padding:2px 6px;font:inherit;border-radius:3px;cursor:pointer;max-width:240px";

  // Build the options list. Skip transient core states (Loading,
  // Rebuilding) — they're SM-driven and not user-selectable.
  const TRANSIENT = new Set(["Loading", "Rebuilding"]);
  const allModes = opts.registry.listModes().filter((m) => !TRANSIENT.has(m.id));
  const tagOrder = (tags: readonly string[] | undefined): number => {
    if (!tags) return 3;
    if (tags.includes("core") || tags.includes("editor")) return 0;
    if (tags.includes("debug")) return 1;
    if (tags.includes("scene")) return 2;
    return 3;
  };
  allModes.sort((a, b) => tagOrder(a.tags) - tagOrder(b.tags) || a.label.localeCompare(b.label));

  // Group with optgroup labels so the dropdown visually separates kinds.
  let currentGroup: HTMLOptGroupElement | null = null;
  let currentGroupKey = -1;
  for (const m of allModes) {
    const key = tagOrder(m.tags);
    if (key !== currentGroupKey) {
      currentGroupKey = key;
      const label = key === 0 ? "modes" : key === 1 ? "debug" : key === 2 ? "scenes" : "other";
      currentGroup = document.createElement("optgroup");
      currentGroup.label = label;
      modeSelect.appendChild(currentGroup);
    }
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    currentGroup!.appendChild(opt);
  }

  // Test levels (= scenarios) appear as a fourth group. They require
  // runtime re-init (different inputSystem, different seed state) so
  // selection performs a URL navigation rather than emitting an event.
  // The play/record sub-modes for each scenario live in the scenario
  // panel's top-menu (= attachTopMenu when mode="scenario").
  const scenarioGroup = document.createElement("optgroup");
  scenarioGroup.label = "test levels";
  modeSelect.appendChild(scenarioGroup);
  for (const name of Object.keys(SCENARIOS).sort()) {
    const opt = document.createElement("option");
    opt.value = `scenario:${name}`;
    opt.textContent = name;
    scenarioGroup.appendChild(opt);
  }
  // Default: the scene from ?map= (= a scene-tagged mode), since boot
  // immediately LoadRequests it.
  const initialScene = new URL(location.href).searchParams.get("map") ?? "canyon-desert";
  modeSelect.value = initialScene;

  modeSelect.addEventListener("change", () => {
    const modeId = modeSelect.value;
    // Scenario items use a `scenario:` prefix; selecting one navigates
    // to ?scenario=<name>, triggering startScenarioWorld on reload.
    // (Scenarios need a different inputSystem + seed state — not a
    // simple buffer swap.)
    if (modeId.startsWith("scenario:")) {
      const u = new URL(location.href);
      u.searchParams.set("scenario", modeId.slice("scenario:".length));
      u.searchParams.delete("map");
      location.href = u.toString();
      return;
    }
    const mode = opts.registry.getMode(modeId);
    if (!mode) return;
    const isScene = mode.tags?.includes("scene");
    const isBuilder = modeId === "Builder";
    const isRunning = modeId === "Running";

    // (DOM panel `.active` class toggling moved to
    // PanelVisibilitySystem — it observes activeMode and toggles
    // classes after the SM transitions. No imperative DOM work here.)

    // Route the event by mode kind.
    if (isScene) {
      opts.emit({ type: "LoadRequested", payload: { sceneName: modeId } });
      const u = new URL(location.href);
      u.searchParams.set("map", modeId);
      history.replaceState({}, "", u.toString());
    } else if (isBuilder) {
      opts.emit({ type: "ModeRequested", payload: { mode: "builder" } });
    } else if (isRunning) {
      opts.emit({ type: "ModeRequested", payload: { mode: "world" } });
    } else {
      // DebugGym, LibraryViewer, future custom modes.
      opts.emit({ type: "ModeSwitchRequested", payload: { modeId } });
    }
  });
  bar.appendChild(modeSelect);

  const sep = document.createElement("span");
  sep.textContent = "│";
  sep.style.color = "#444";
  bar.appendChild(sep);

  // Character binding picker — each binding installs a distinct
  // CharacterControllerProfile into the character intent slot
  // (= different 6DoF accel curves, grip, turn rate). Standard /
  // agile / heavy each have noticeably different feel because the
  // existing controller systems read from CharacterControllerProfileBuffer
  // and pick up the new curves on the next tick. See
  // src/app/characterBindings.ts.
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
    // Emit a BindingRequested event — BindingSwapSystem (registered in
    // bootstrap) drains it and applies the matching binding via
    // applyControllerBinding. No direct buffer mutation here.
    opts.emit({ type: "BindingRequested", payload: { bindingId: bindingSelect.value } });
  });
  bar.appendChild(bindingSelect);

  const sep2 = document.createElement("span");
  sep2.textContent = "│";
  sep2.style.color = "#444";
  bar.appendChild(sep2);

  // Library Viewer toggle. Emits ModeSwitchRequested events; the SM
  // handles the swap (setting activeMode), OverlayVisibilitySystem
  // reads activeMode and toggles panel display. No direct buffer
  // mutation. Tech-debt payoff 2026-05-23.
  const libBtn = document.createElement("button");
  libBtn.textContent = "📚 inspect (F1)";
  libBtn.style.cssText = "background:#2c4a78;color:#fff;border:1px solid #444;padding:2px 8px;font:inherit;border-radius:3px;cursor:pointer";
  function toggleInspector() {
    const sm = readBuffer(opts.registry.getBuffer<StateMachineBufferData>("stateMachine"));
    const inInspector = sm.activeMode === "LibraryViewer";
    if (inInspector) {
      // Exit — return to whatever graph the FSM state maps to.
      opts.emit({ type: "ModeSwitchRequested", payload: { modeId: sm.activeGraph } });
      libBtn.style.background = "#2c4a78";
      libBtn.textContent = "📚 inspect (F1)";
    } else {
      opts.emit({ type: "ModeSwitchRequested", payload: { modeId: "LibraryViewer" } });
      libBtn.style.background = "#5a8";
      libBtn.textContent = "📚 close (F1)";
    }
  }
  libBtn.addEventListener("click", toggleInspector);
  window.addEventListener("keydown", (e) => {
    if (e.key === "F1") {
      e.preventDefault();
      toggleInspector();
    }
  });
  bar.appendChild(libBtn);

  document.body.appendChild(bar);
}

interface TopMenuOptions {
  mode: "normal" | "scenario";
  scenarioName?: string;
  /** Registry — used to register scenario sub-modes + read activeMode
   *  for keydown handling. The actual input-system swap is done by
   *  InputSourceSelectorSystem, not here. */
  registry?: Registry;
  /** Recording state — needed only for status-line text (frame counter
   *  rendered in the rAF tick). The selector mutates it. */
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

  if (opts.mode === "scenario" && opts.registry && opts.recordingState) {
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
    const recording = opts.recordingState;

    // Register the three scenario sub-modes. Their `systems` lists
    // include the InputSourceSelectorSystem (registered in
    // startScenarioWorld) so it runs in every sub-mode and reacts to
    // activeMode changes by swapping the input descriptor + flipping
    // the recording flag. The buttons themselves do nothing but emit
    // the event + update UI feedback — no imperative replaceSystem
    // or recording.active mutation here. Per user 2026-05-23: "use
    // the systems we build and patterns we build".
    const baseSystems = reg.getMode("Running")!.systems;
    const scenarioSystems = baseSystems.includes("inputSourceSelectorSystem")
      ? baseSystems
      : [...baseSystems, "inputSourceSelectorSystem"];
    reg.registerMode({
      id: "ScenarioPlayback",
      label: `▶ ${opts.scenarioName} (playback)`,
      tags: ["scenario-state"],
      systems: scenarioSystems,
    });
    reg.registerMode({
      id: "ScenarioFreePlay",
      label: `● ${opts.scenarioName} (free play)`,
      tags: ["scenario-state"],
      systems: scenarioSystems,
    });
    reg.registerMode({
      id: "ScenarioRecording",
      label: `⏺ ${opts.scenarioName} (recording)`,
      tags: ["scenario-state"],
      systems: scenarioSystems,
    });
    // Initial activeMode: playback. The selector will observe the
    // first tick's activeMode and apply ScenarioPlayback's spec.
    writeBuffer(
      reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID),
      (d) => { d.activeMode = "ScenarioPlayback"; },
    );

    function setStatus(text: string, color: string): void {
      status.textContent = text;
      status.style.color = color;
    }
    function emitMode(modeId: string): void {
      const events = reg.getBuffer<RuntimeEvent[]>("events");
      writeBuffer(events, (d) => { d.push({ type: "ModeSwitchRequested", payload: { modeId } }); });
    }

    function startFreePlay(): void {
      emitMode("ScenarioFreePlay");
      setStatus("● live input", "#fa3");
      playBtn.style.display = "none";
      recBtn.style.display = "none";
      stopBtn.style.display = "";
      stopBtn.textContent = "⏹ back to playback";
    }
    function startRecording(): void {
      emitMode("ScenarioRecording");
      setStatus(`⏺ recording 0/${recording.frameCap}`, "#f44");
      playBtn.style.display = "none";
      recBtn.style.display = "none";
      stopBtn.style.display = "";
      stopBtn.textContent = "⏹ stop + dump";
    }
    function stop(): void {
      const wasRecording = recording.active;
      emitMode("ScenarioPlayback");
      if (wasRecording) {
        // The selector's onRecordingComplete callback already
        // dumped the recording to the console; just update status.
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
      const sm = readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      const inLiveMode = sm.activeMode === "ScenarioFreePlay" || sm.activeMode === "ScenarioRecording";
      if (e.code === "Escape" && inLiveMode) {
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

