/**
 * Library Viewer — a registered Mode whose system snapshots the
 * runtime registries (buffers / systems / modes / active graph) into a
 * `LibraryViewerBuffer` for the inspector overlay to render.
 *
 * No DOM here. The renderer reads this buffer's data and produces the
 * overlay; that lives separately (Phase 6b — DOM render system).
 *
 * Per docs/modes-and-modules.md: the library viewer is itself a mode in
 * the registry — switching to LibraryViewerMode activates this system,
 * the inspector overlay renders, and you can cycle modes from inside
 * the inspector.
 */

import { createBuffer, readBuffer, writeBuffer, type Buffer } from "./buffer";
import { exportGraphSnapshot, type ExecutionGraphSnapshot } from "./mode";
import { getOrBuildGraphForMode } from "./mode";
import type { SystemDescriptor } from "./system";
import type { Registry } from "./registry";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "./stateMachine";

export const LIBRARY_VIEWER_BUFFER_ID = "libraryViewer";
export const LIBRARY_VIEWER_SYSTEM_ID = "libraryViewerSystem";
export const LIBRARY_VIEWER_RENDER_SYSTEM_ID = "libraryViewerRenderSystem";
export const LIBRARY_VIEWER_MODE_ID = "LibraryViewer";

export interface LibraryViewerBufferData {
  /** Per-buffer summary: id, description, current version. */
  buffers: { id: string; description: string; version: number }[];
  /** Per-system summary: id, description, buffer reads + writes. */
  systems: { id: string; description: string; reads: string[]; writes: string[] }[];
  /** Per-mode summary: id, label, optional tags. */
  modes: { id: string; label: string; tags: string[] }[];
  /** Mode id the runtime is currently executing. */
  activeMode: string;
  /** Snapshot of the active mode's derived execution graph. */
  activeGraphSnapshot: ExecutionGraphSnapshot | null;
}

export function createLibraryViewerBuffer(): Buffer<LibraryViewerBufferData> {
  return createBuffer<LibraryViewerBufferData>({
    id: LIBRARY_VIEWER_BUFFER_ID,
    description:
      "Snapshot of the runtime registries (buffers, systems, modes) plus the active mode's graph, refreshed each tick the Library Viewer mode is active. Read by the inspector overlay renderer.",
    initial: {
      buffers: [],
      systems: [],
      modes: [],
      activeMode: "",
      activeGraphSnapshot: null,
    },
  });
}

/**
 * Library Viewer system factory. Closes over the registry so the
 * system can enumerate all registered buffers/systems/modes each tick.
 * Cheap by design — pulls metadata, not per-entity buffer data.
 */
export function createLibraryViewerSystem(reg: Registry): SystemDescriptor {
  return {
    id: LIBRARY_VIEWER_SYSTEM_ID,
    description:
      "Library Viewer data system. Enumerates registered buffers, systems, and modes; snapshots the active mode's execution graph; writes the summary into LibraryViewerBuffer for the inspector overlay.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: LIBRARY_VIEWER_BUFFER_ID, access: "readwrite" },
    ],
    execute: ({ buffer }) => {
      // Buffers: capture id + description + current version.
      const buffers = reg.listBuffers().map((b) => ({
        id: b.id,
        description: b.description,
        version: b.version,
      }));
      // Systems: capture id + description + per-system buffer access split
      // into reads / writes (readwrite → both).
      const systems = reg.listSystems().map((s) => {
        const reads: string[] = [];
        const writes: string[] = [];
        for (const ba of s.buffers) {
          if (ba.access === "read") reads.push(ba.id);
          else if (ba.access === "write") writes.push(ba.id);
          else if (ba.access === "readwrite") {
            reads.push(ba.id);
            writes.push(ba.id);
          }
        }
        return { id: s.id, description: s.description, reads, writes };
      });
      // Modes: capture id + label + tags.
      const modes = reg.listModes().map((m) => ({
        id: m.id,
        label: m.label,
        tags: m.tags ?? [],
      }));
      // Active graph snapshot — null when no SM buffer exists (= unit
      // tests without the SM wired).
      const activeMode = reg.hasBuffer(STATE_MACHINE_BUFFER_ID)
        ? readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID)).activeMode
        : "";
      let activeGraphSnapshot: ExecutionGraphSnapshot | null = null;
      if (activeMode && reg.hasMode(activeMode)) {
        try {
          const g = getOrBuildGraphForMode(reg, activeMode);
          activeGraphSnapshot = exportGraphSnapshot(g, reg);
        } catch {
          // Active mode not buildable yet (= scenario harness with
          // partial registry). Leave snapshot null.
        }
      }

      const lib = buffer<LibraryViewerBufferData>(LIBRARY_VIEWER_BUFFER_ID);
      writeBuffer(lib, (d) => {
        d.buffers = buffers;
        d.systems = systems;
        d.modes = modes;
        d.activeMode = activeMode;
        d.activeGraphSnapshot = activeGraphSnapshot;
      });
    },
  };
}

/** Minimal element interface the render system writes to. Production
 *  passes an HTMLElement; tests pass a stub `{ innerHTML: string }`.
 *  `style` is optional so the same target can also feed
 *  OverlayVisibilitySystem (= toggles display) without dual stubs. */
export interface LibraryViewerRenderTarget {
  innerHTML: string;
  style?: { display: string };
}

/**
 * Render system factory. Reads the LibraryViewerBuffer (populated by
 * `libraryViewerSystem`) and writes formatted HTML to the target
 * element. Pass `null` to no-op (= production may register the system
 * before the DOM panel exists; the no-op path keeps the mode bootable
 * in test harnesses without a DOM).
 *
 * No styling is included — the host page is expected to scope the
 * panel via its own CSS. Output structure:
 *
 *   <div class="lv">
 *     <h2>Library Viewer</h2>
 *     <div>Active Mode: <strong>{id}</strong></div>
 *     <h3>Buffers ({n})</h3><ul>...</ul>
 *     <h3>Systems ({n})</h3><ul>...</ul>
 *     <h3>Modes ({n})</h3><ul>...</ul>
 *   </div>
 */
export function createLibraryViewerRenderSystem(
  target: LibraryViewerRenderTarget | null,
): SystemDescriptor {
  return {
    id: LIBRARY_VIEWER_RENDER_SYSTEM_ID,
    description:
      "Renders LibraryViewerBuffer's registry summary as HTML into a target DOM element. Inspector overlay for the runtime registries. No-ops when no target is provided.",
    buffers: [{ id: LIBRARY_VIEWER_BUFFER_ID, access: "read" }],
    runsAfter: [LIBRARY_VIEWER_SYSTEM_ID],
    execute: ({ buffer }) => {
      if (!target) return;
      const data = readBuffer(buffer<LibraryViewerBufferData>(LIBRARY_VIEWER_BUFFER_ID));
      target.innerHTML = renderLibraryViewer(data);
    },
  };
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Scoped CSS for the LibraryViewer panel. Self-contained — emitted
 * inline so the host page needs no additional stylesheet. All
 * selectors are prefixed `.lv` so they don't leak into surrounding
 * DOM.
 */
const LIBRARY_VIEWER_CSS = `
<style>
.lv { font: 12px/1.5 ui-monospace, "Cascadia Code", Menlo, Consolas, monospace; color: #d6d9df; }
.lv h2 { margin: 0 0 8px 0; font-size: 14px; color: #fff; border-bottom: 1px solid #444; padding-bottom: 4px; }
.lv h3 { margin: 14px 0 4px; font-size: 12px; color: #8ab; text-transform: uppercase; letter-spacing: 0.04em; }
.lv .lv-active { font-size: 13px; margin-bottom: 6px; }
.lv .lv-active strong { color: #9ec; }
.lv .lv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.lv .lv-full { grid-column: 1 / -1; }
.lv ul { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow: auto; border: 1px solid #2a2e36; border-radius: 4px; background: #0b0e13; }
.lv li { padding: 3px 8px; border-bottom: 1px solid #1a1d24; }
.lv li:nth-child(even) { background: #0d1018; }
.lv li:last-child { border-bottom: 0; }
.lv code { color: #ecaf3a; font-weight: 600; }
.lv small { color: #7a8290; font-size: 11px; }
.lv .lv-tags { color: #6c8a99; }
.lv .lv-active-row { background: #1a3050 !important; }
.lv .lv-graph { font-size: 11px; max-height: 320px; overflow: auto; padding: 6px 8px; background: #0b0e13; border: 1px solid #2a2e36; border-radius: 4px; }
.lv .lv-graph div { padding: 1px 0; }
.lv .lv-graph .ar { color: #6c8a99; font-size: 10px; padding-left: 12px; }
</style>`;

function renderLibraryViewer(data: LibraryViewerBufferData): string {
  const buffersHtml = data.buffers
    .map((b) => `<li><code>${escape(b.id)}</code> <small>v${b.version}</small> — ${escape(b.description)}</li>`)
    .join("");
  const systemsHtml = data.systems
    .map((s) => {
      const reads = s.reads.length ? `r: [${s.reads.map(escape).join(", ")}]` : "";
      const writes = s.writes.length ? `w: [${s.writes.map(escape).join(", ")}]` : "";
      const meta = [reads, writes].filter(Boolean).join(" · ");
      return `<li><code>${escape(s.id)}</code> — ${escape(s.description)}${meta ? `<br><small>${meta}</small>` : ""}</li>`;
    })
    .join("");
  const modesHtml = data.modes
    .map((m) => {
      const tags = m.tags.length ? ` <span class="lv-tags">[${m.tags.map(escape).join(", ")}]</span>` : "";
      const isActive = m.id === data.activeMode ? " class=\"lv-active-row\"" : "";
      return `<li${isActive}><code>${escape(m.id)}</code> — ${escape(m.label)}${tags}</li>`;
    })
    .join("");
  // Active graph topological order — most useful single view of
  // what's executing this tick. Each node shows id; runsAfter edges
  // would clutter but are accessible via the .nodes / .edges fields
  // on the snapshot if a more elaborate visualization wants them.
  const graphHtml = data.activeGraphSnapshot
    ? data.activeGraphSnapshot.topoOrder
        .map((id, i) => `<div><small>${String(i + 1).padStart(2, "0")}.</small> <code>${escape(id)}</code></div>`)
        .join("")
    : "<small>(no active graph)</small>";
  return `${LIBRARY_VIEWER_CSS}<div class="lv">
<h2>Library Viewer</h2>
<div class="lv-active">Active Mode: <strong>${escape(data.activeMode || "(none)")}</strong></div>
<div class="lv-grid">
  <div>
    <h3>Buffers (${data.buffers.length})</h3>
    <ul>${buffersHtml}</ul>
  </div>
  <div>
    <h3>Modes (${data.modes.length})</h3>
    <ul>${modesHtml}</ul>
  </div>
  <div class="lv-full">
    <h3>Systems (${data.systems.length})</h3>
    <ul>${systemsHtml}</ul>
  </div>
  <div class="lv-full">
    <h3>Active graph — tick order (${data.activeGraphSnapshot?.topoOrder.length ?? 0})</h3>
    <div class="lv-graph">${graphHtml}</div>
  </div>
</div>
</div>`;
}

/**
 * Register the Library Viewer mode in the registry. Idempotent guard
 * is the registry's `register` throw-on-duplicate.
 *
 * The mode's `systems` list includes the renderer; bootstrap is
 * expected to register `createLibraryViewerRenderSystem(target)` with a
 * real element (or `null` if no DOM panel is wired). Tests register
 * with a stub element.
 */
export function registerLibraryViewerMode(reg: Registry): void {
  reg.registerMode({
    id: LIBRARY_VIEWER_MODE_ID,
    label: "Library Viewer",
    tags: ["debug"],
    systems: [
      // SM ticks so ModeSwitchRequested events (= "exit inspector
      // overlay back to gameplay") are processed.
      "stateMachineSystem",
      // Overlay visibility tracker also ticks so toggling out flips
      // the panel back to hidden.
      "overlayVisibilitySystem",
      // Binding swap + library viewer data + render.
      "bindingSwapSystem",
      LIBRARY_VIEWER_SYSTEM_ID,
      LIBRARY_VIEWER_RENDER_SYSTEM_ID,
    ],
    ownedBuffers: [LIBRARY_VIEWER_BUFFER_ID],
  });
}
