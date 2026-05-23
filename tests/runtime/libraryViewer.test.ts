import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  LIBRARY_VIEWER_BUFFER_ID,
  LIBRARY_VIEWER_SYSTEM_ID,
  LIBRARY_VIEWER_MODE_ID,
  createLibraryViewerBuffer,
  createLibraryViewerSystem,
  registerLibraryViewerMode,
  type LibraryViewerBufferData,
} from "../../src/runtime/libraryViewer";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../../src/runtime/stateMachine";
import type { SystemDescriptor } from "../../src/runtime/system";

/**
 * Phase 6: a registered "LibraryViewer" mode whose system inspects the
 * runtime registries (buffers, systems, modes) and the active graph
 * snapshot, writing the result into a `LibraryViewerBuffer` that the
 * future inspector overlay reads.
 *
 * No DOM rendering here — that's Phase 6b. The data side is testable
 * headless.
 */

function syntheticSystem(id: string, reads: string[] = [], writes: string[] = []): SystemDescriptor {
  return {
    id,
    description: `synthetic ${id}`,
    buffers: [
      ...reads.map((b) => ({ id: b, access: "read" as const })),
      ...writes.map((b) => ({ id: b, access: "write" as const })),
    ],
    execute: () => {},
  };
}

describe("LibraryViewer mode + system", () => {
  function setup() {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer({ id: "a-buf", description: "buffer A", initial: { v: 1 } }));
    reg.registerBuffer(createBuffer({ id: "b-buf", description: "buffer B", initial: { v: 2 } }));
    reg.registerBuffer(createLibraryViewerBuffer());
    // The library viewer system declares it reads STATE_MACHINE_BUFFER_ID
    // to capture `activeMode`. The hazard checker requires the buffer
    // to be registered even when we only sanity-test the system.
    reg.registerBuffer(createBuffer<StateMachineBufferData>({
      id: STATE_MACHINE_BUFFER_ID,
      description: "FSM state (test stub)",
      initial: {
        state: "Running",
        activeGraph: "Running",
        activeMode: "Running",
        pendingEvents: [],
        pendingLoad: null,
        pendingRebuild: null,
        rebuildGeneration: 0,
      },
    }));
    reg.registerSystem(syntheticSystem("sys-a", [], ["a-buf"]));
    reg.registerSystem(syntheticSystem("sys-b", ["a-buf"], ["b-buf"]));
    reg.registerSystem(createLibraryViewerSystem(reg));
    registerLibraryViewerMode(reg);
    return reg;
  }

  it("registers LIBRARY_VIEWER_MODE_ID as a Mode in the registry", () => {
    const reg = setup();
    expect(reg.hasMode(LIBRARY_VIEWER_MODE_ID)).toBe(true);
    const mode = reg.getMode(LIBRARY_VIEWER_MODE_ID)!;
    expect(mode.systems).toContain(LIBRARY_VIEWER_SYSTEM_ID);
    expect(mode.tags).toContain("debug");
  });

  it("captures the buffer registry summary on tick", () => {
    const reg = setup();
    const g = buildExecutionGraph({ id: "g", nodes: [LIBRARY_VIEWER_SYSTEM_ID], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const lib = readBuffer(reg.getBuffer<LibraryViewerBufferData>(LIBRARY_VIEWER_BUFFER_ID));
    expect(lib.buffers.find((b) => b.id === "a-buf")?.description).toBe("buffer A");
    expect(lib.buffers.find((b) => b.id === "b-buf")?.description).toBe("buffer B");
  });

  it("captures the system registry summary on tick", () => {
    const reg = setup();
    const g = buildExecutionGraph({ id: "g", nodes: [LIBRARY_VIEWER_SYSTEM_ID], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const lib = readBuffer(reg.getBuffer<LibraryViewerBufferData>(LIBRARY_VIEWER_BUFFER_ID));
    const sysA = lib.systems.find((s) => s.id === "sys-a");
    const sysB = lib.systems.find((s) => s.id === "sys-b");
    expect(sysA).toBeDefined();
    expect(sysA!.writes).toContain("a-buf");
    expect(sysB!.reads).toContain("a-buf");
    expect(sysB!.writes).toContain("b-buf");
  });

  it("captures the mode registry summary on tick", () => {
    const reg = setup();
    reg.registerMode({ id: "extra", label: "Extra", systems: [], tags: ["scene"] });
    const g = buildExecutionGraph({ id: "g", nodes: [LIBRARY_VIEWER_SYSTEM_ID], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const lib = readBuffer(reg.getBuffer<LibraryViewerBufferData>(LIBRARY_VIEWER_BUFFER_ID));
    const ids = lib.modes.map((m) => m.id).sort();
    expect(ids).toContain(LIBRARY_VIEWER_MODE_ID);
    expect(ids).toContain("extra");
  });

  it("library viewer summary is JSON-serializable", () => {
    const reg = setup();
    const g = buildExecutionGraph({ id: "g", nodes: [LIBRARY_VIEWER_SYSTEM_ID], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    const lib = readBuffer(reg.getBuffer<LibraryViewerBufferData>(LIBRARY_VIEWER_BUFFER_ID));
    expect(() => JSON.stringify(lib)).not.toThrow();
  });
});
