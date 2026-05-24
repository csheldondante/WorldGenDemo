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
import { buildAndRegisterCoreGraphs, RUNNING_GRAPH_ID } from "./graphs";
import { registerSceneModes } from "../runtime/sceneModes";
import {
  registerLibraryViewerMode,
  type LibraryViewerRenderTarget,
} from "../runtime/libraryViewer";
import { SCENE_CATALOG } from "./sceneCatalog";
import { registerTransitions } from "./transitions";
import { createTransitionActivatorSystem } from "./transitionActivator";
import {
  createPanelVisibilitySystem,
  type PanelClassTarget,
} from "../runtime/panelVisibility";
import {
  createProfileEditorBuffer,
  createProfileEditorRenderSystem,
  registerProfileEditorMode,
  type ProfileEditorRenderTarget,
} from "./profileEditor";
import { registerBipedDefaultBinding } from "./bipedBinding";
import { applyControllerBinding } from "./applyControllerBinding";
import { materializeBindings, BIPED_STANDARD } from "./characterBindings";
import type { ControllerBinding } from "../runtime/moduleSlots";
import { registerInfrastructureSystems } from "../runtime/infrastructureSystems";

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
  /** DOM element the Library Viewer renderer writes HTML into when the
   *  LibraryViewer mode is active. If undefined, the renderer is
   *  registered with a null target (= no-op). Optional. */
  libraryViewerTarget?: LibraryViewerRenderTarget | null;
  /** DOM panel for the ProfileEditor mode. Null = no-op. */
  profileEditorTarget?: ProfileEditorRenderTarget | null;
  /** Top-level DOM panels keyed by their conceptual role (= "world"
   *  vs "builder"). PanelVisibilitySystem toggles `.active` based on
   *  activeMode: Builder mode → builder panel active; else world. */
  panels?: { world?: PanelClassTarget | null; builder?: PanelClassTarget | null };
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
  /** Character bindings ready to apply via `applyControllerBinding(reg, b)`.
   *  Materialized at bootstrap from `CHARACTER_BINDINGS` × biped:default's
   *  slot assignments. Phase 5 — see `docs/modes-and-modules.md`. */
  characterBindings: ControllerBinding[];
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
  // Phase 4d/5 — register the biped:default module set + materialize
  // the character bindings catalog (standard/agile/heavy). Done BEFORE
  // infrastructure registration so BindingSwapSystem gets the real
  // catalog, and BEFORE graph build so Running's reference resolves.
  const { binding: bipedDefault } = registerBipedDefaultBinding(reg);
  void bipedDefault; // module registry side-effect is what we want
  const characterBindings = materializeBindings(bipedDefault);
  // Infrastructure systems (library viewer + binding swap + overlay
  // visibility + their buffers). Tests + bootstrap use the same helper;
  // see src/runtime/infrastructureSystems.ts.
  registerInfrastructureSystems(reg, {
    libraryViewerTarget: options.libraryViewerTarget ?? null,
    bindingCatalog: characterBindings,
    applyBinding: (b) => applyControllerBinding(reg, b),
    // BindingSwapSystem declares write access to the buffer the
    // installer touches (= the character profile buffer for the
    // characterIntent slot). Hazard validator uses this to flag any
    // other writer/reader collisions.
    bindingWriteBufferIds: ["characterControllerProfile"],
    // ... and runs BEFORE every character system that reads the
    // profile so a binding swap takes effect on the same tick.
    bindingReaderSystemIds: [
      "bodyLeanSystem",
      "characterControllerSystem",
      "characterOrientationSystem",
      "footIkSystem",
      "footPlannerSystem",
      "forceFieldSystem",
      "surfaceConstrainedVelocitySystem",
      "surfaceConstraintSystem",
      "tangentInputMapperSystem",
    ],
    // Phase 3b — transition activator. Lives in src/app/ (knows the
    // SM-state → app-transition mapping). Loading + Rebuilding graphs
    // reference this system by id.
    // PanelVisibilitySystem — toggles top-level .world/.builder DOM
    // panel `.active` class from activeMode (= replaces imperative
    // toggling from the mode-dropdown handler).
    extraSystems: [
      createTransitionActivatorSystem(),
      createPanelVisibilitySystem({
        bindings: [
          {
            panel: options.panels?.world ?? null,
            isActiveFor: (m) => m !== "Builder",
          },
          {
            panel: options.panels?.builder ?? null,
            isActiveFor: (m) => m === "Builder",
          },
        ],
      }),
    ],
    // App-specific overlay bindings beyond the LibraryViewer panel.
    extraOverlays: options.profileEditorTarget
      ? [{
          modeId: "ProfileEditor",
          target: options.profileEditorTarget.style
            ? (options.profileEditorTarget as { style: { display: string } })
            : null,
        }]
      : [],
  });
  buildAndRegisterCoreGraphs(reg); // validates: throws if any contract is violated
  // Register every catalog scene as a Mode sharing the Running graph's
  // system list. Switching to a scene mode = same gameplay, different
  // scene data; the existing LoadRequested event drives the data load.
  registerSceneModes(reg, SCENE_CATALOG, reg.getMode(RUNNING_GRAPH_ID)!.systems);
  // Register the LibraryViewer mode itself (= different system list, =
  // very different from the gameplay modes). Switching to it stops
  // gameplay and shows the registry overlay.
  registerLibraryViewerMode(reg);
  // Profile editor mode + its render system + selector buffer. Edits
  // write back into CharacterControllerProfileBuffer directly — see
  // src/app/profileEditor.ts. No intermediate snapshot buffer: the
  // render system reads the canonical profile buffer.
  reg.registerBuffer(createProfileEditorBuffer());
  reg.registerSystem(createProfileEditorRenderSystem(options.profileEditorTarget ?? null));
  registerProfileEditorMode(reg);
  // Phase 3b — register app-level transitions. The Rebuilding pipeline
  // is now also expressed as a Transition (Loading → Running via the
  // Rebuilding graph). The runtime loop honors transitions via
  // TransitionStateBuffer + isComplete polling. See src/app/transitions.ts.
  registerTransitions(reg);
  // Apply the default standard binding immediately so the character
  // profile buffer has sensible values from tick 0.
  applyControllerBinding(reg, characterBindings.find((b) => b.id === BIPED_STANDARD.id)!);
  // Register a "DebugGym" mode: same systems as Running, tagged "debug".
  // Cycling UI uses it as a sandbox for binding experimentation.
  reg.registerMode({
    id: "DebugGym",
    label: "Debug Gym",
    tags: ["debug", "gym"],
    systems: reg.getMode("Running")!.systems,
  });

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
    characterBindings,
  };
}
