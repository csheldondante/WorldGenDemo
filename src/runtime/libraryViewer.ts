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

/**
 * Register the Library Viewer mode in the registry. Idempotent guard
 * is the registry's `register` throw-on-duplicate.
 */
export function registerLibraryViewerMode(reg: Registry): void {
  reg.registerMode({
    id: LIBRARY_VIEWER_MODE_ID,
    label: "Library Viewer",
    tags: ["debug"],
    systems: [LIBRARY_VIEWER_SYSTEM_ID],
    ownedBuffers: [LIBRARY_VIEWER_BUFFER_ID],
  });
}
