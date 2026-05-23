import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  OVERLAY_VISIBILITY_SYSTEM_ID,
  createOverlayVisibilitySystem,
} from "../../src/runtime/overlayVisibility";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../../src/runtime/stateMachine";

interface StubEl { style: { display: string }; }

/**
 * Tech-debt payoff 2026-05-23: panel visibility is driven by a system
 * that reads `activeMode` each tick, not by DOM event handlers
 * imperatively setting `display`. Lets the overlay react to mode
 * switches that originate anywhere — UI, scenarios, scripted.
 */
describe("createOverlayVisibilitySystem", () => {
  function setup() {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer<StateMachineBufferData>({
      id: STATE_MACHINE_BUFFER_ID,
      description: "FSM state stub",
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
    const stub: StubEl = { style: { display: "none" } };
    reg.registerSystem(
      createOverlayVisibilitySystem({
        target: stub,
        showWhenActiveMode: "LibraryViewer",
      }),
    );
    return { reg, stub };
  }

  function tick(reg: ReturnType<typeof setup>["reg"]) {
    const g = buildExecutionGraph({
      id: "g",
      nodes: [OVERLAY_VISIBILITY_SYSTEM_ID],
      registry: reg,
    });
    executeGraph(g, reg, { dt: 0, now: 0 });
  }

  it("hides the element when activeMode != showWhenActiveMode", () => {
    const { reg, stub } = setup();
    stub.style.display = "block"; // pre-state — should be overridden
    tick(reg);
    expect(stub.style.display).toBe("none");
  });

  it("shows the element when activeMode == showWhenActiveMode", () => {
    const { reg, stub } = setup();
    writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
      d.activeMode = "LibraryViewer";
    });
    tick(reg);
    expect(stub.style.display).toBe("block");
  });

  it("tracks activeMode changes across ticks", () => {
    const { reg, stub } = setup();
    tick(reg);
    expect(stub.style.display).toBe("none");
    writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
      d.activeMode = "LibraryViewer";
    });
    tick(reg);
    expect(stub.style.display).toBe("block");
    writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
      d.activeMode = "Running";
    });
    tick(reg);
    expect(stub.style.display).toBe("none");
  });

  it("null target → system is a no-op", () => {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer<StateMachineBufferData>({
      id: STATE_MACHINE_BUFFER_ID,
      description: "",
      initial: { state: "Running", activeGraph: "Running", activeMode: "LibraryViewer", pendingEvents: [], pendingLoad: null, pendingRebuild: null, rebuildGeneration: 0 },
    }));
    reg.registerSystem(createOverlayVisibilitySystem({ target: null, showWhenActiveMode: "LibraryViewer" }));
    const g = buildExecutionGraph({ id: "g", nodes: [OVERLAY_VISIBILITY_SYSTEM_ID], registry: reg });
    expect(() => executeGraph(g, reg, { dt: 0, now: 0 })).not.toThrow();
  });
});
