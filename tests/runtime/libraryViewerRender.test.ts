import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  LIBRARY_VIEWER_SYSTEM_ID,
  LIBRARY_VIEWER_RENDER_SYSTEM_ID,
  createLibraryViewerBuffer,
  createLibraryViewerSystem,
  createLibraryViewerRenderSystem,
} from "../../src/runtime/libraryViewer";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../../src/runtime/stateMachine";
import type { SystemDescriptor } from "../../src/runtime/system";

/**
 * Phase 6b: DOM renderer for the Library Viewer mode. Reads the
 * LibraryViewerBuffer (populated by the Phase 6 data system) and writes
 * formatted HTML to a target element. Tested headlessly with a stub
 * element interface — production wires it to a real DOM panel via
 * bootstrap.
 */

interface StubEl { innerHTML: string; }

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

describe("LibraryViewer render system", () => {
  function setup(el: StubEl) {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer({ id: "alpha", description: "alpha buffer", initial: { v: 1 } }));
    reg.registerBuffer(createBuffer({ id: "beta", description: "beta buffer", initial: { v: 2 } }));
    reg.registerBuffer(createLibraryViewerBuffer());
    reg.registerBuffer(createBuffer<StateMachineBufferData>({
      id: STATE_MACHINE_BUFFER_ID,
      description: "FSM state (stub)",
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
    reg.registerSystem(syntheticSystem("sys-alpha", [], ["alpha"]));
    reg.registerSystem(syntheticSystem("sys-beta", ["alpha"], ["beta"]));
    reg.registerSystem(createLibraryViewerSystem(reg));
    reg.registerSystem(createLibraryViewerRenderSystem(el));
    reg.registerMode({ id: "Running", label: "Running", systems: [], tags: ["core"] });
    return reg;
  }

  function runDataThenRender(reg: ReturnType<typeof setup>) {
    const g = buildExecutionGraph({
      id: "g",
      nodes: [LIBRARY_VIEWER_SYSTEM_ID, LIBRARY_VIEWER_RENDER_SYSTEM_ID],
      registry: reg,
    });
    executeGraph(g, reg, { dt: 0, now: 0 });
  }

  it("renders buffer registry entries into the element", () => {
    const el: StubEl = { innerHTML: "" };
    const reg = setup(el);
    runDataThenRender(reg);
    expect(el.innerHTML).toContain("alpha");
    expect(el.innerHTML).toContain("alpha buffer");
    expect(el.innerHTML).toContain("beta");
  });

  it("renders system registry entries with reads/writes", () => {
    const el: StubEl = { innerHTML: "" };
    const reg = setup(el);
    runDataThenRender(reg);
    expect(el.innerHTML).toContain("sys-alpha");
    expect(el.innerHTML).toContain("sys-beta");
    // Reads and writes appear somewhere in the markup near the system row.
    expect(el.innerHTML.toLowerCase()).toContain("read");
    expect(el.innerHTML.toLowerCase()).toContain("write");
  });

  it("renders the active mode name", () => {
    const el: StubEl = { innerHTML: "" };
    const reg = setup(el);
    runDataThenRender(reg);
    expect(el.innerHTML).toContain("Running");
  });

  it("renders mode registry entries", () => {
    const el: StubEl = { innerHTML: "" };
    const reg = setup(el);
    reg.registerMode({ id: "MyScene", label: "My Scene", systems: [], tags: ["scene"] });
    runDataThenRender(reg);
    expect(el.innerHTML).toContain("MyScene");
  });

  it("does not throw when given a null element (= no-op when DOM absent)", () => {
    const reg = setup({ innerHTML: "" });
    // Replace the render system with one that has no element.
    reg.replaceSystem(createLibraryViewerRenderSystem(null));
    expect(() => runDataThenRender(reg)).not.toThrow();
  });
});
