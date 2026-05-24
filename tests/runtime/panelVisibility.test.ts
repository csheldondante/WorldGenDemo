/**
 * PanelVisibilitySystem — observes activeMode and toggles `.active`
 * class on matching DOM panels. Tests use synthetic stub panels
 * with a minimal classList API.
 */

import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { createStateMachineBuffer } from "../../src/buffers/stateMachine";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../../src/runtime/stateMachine";
import {
  createPanelVisibilitySystem,
  PANEL_VISIBILITY_SYSTEM_ID,
  type PanelClassTarget,
} from "../../src/runtime/panelVisibility";

function makePanel(): PanelClassTarget & { _classes: Set<string> } {
  const classes = new Set<string>();
  return {
    _classes: classes,
    classList: {
      add: (n) => { classes.add(n); },
      remove: (n) => { classes.delete(n); },
      contains: (n) => classes.has(n),
    },
  };
}

describe("PanelVisibilitySystem", () => {
  function setup() {
    const reg = createRegistry();
    reg.registerBuffer(createStateMachineBuffer());
    const world = makePanel();
    const builder = makePanel();
    reg.registerSystem(createPanelVisibilitySystem({
      bindings: [
        { panel: world, isActiveFor: (m) => m !== "Builder" },
        { panel: builder, isActiveFor: (m) => m === "Builder" },
      ],
    }));
    const graph = buildExecutionGraph({ id: "test", nodes: [PANEL_VISIBILITY_SYSTEM_ID], registry: reg });
    return {
      reg, world, builder,
      setMode: (m: string) => writeBuffer(
        reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID),
        (d) => { d.activeMode = m; },
      ),
      tick: () => executeGraph(graph, reg, { dt: 1 / 60, now: 0 }),
    };
  }

  it("activates the world panel when activeMode is non-Builder", () => {
    const { world, builder, setMode, tick } = setup();
    setMode("Running");
    tick();
    expect(world._classes.has("active")).toBe(true);
    expect(builder._classes.has("active")).toBe(false);
  });

  it("activates the builder panel when activeMode === Builder", () => {
    const { world, builder, setMode, tick } = setup();
    setMode("Builder");
    tick();
    expect(builder._classes.has("active")).toBe(true);
    expect(world._classes.has("active")).toBe(false);
  });

  it("flips panels when activeMode changes between ticks", () => {
    const { world, builder, setMode, tick } = setup();
    setMode("Running");
    tick();
    expect(world._classes.has("active")).toBe(true);
    setMode("Builder");
    tick();
    expect(builder._classes.has("active")).toBe(true);
    expect(world._classes.has("active")).toBe(false);
  });

  it("idempotent on same mode (= no class churn)", () => {
    const { world, setMode, tick } = setup();
    setMode("Running");
    tick();
    tick();
    tick();
    expect(world._classes.has("active")).toBe(true);
  });

  it("null panels are skipped (= safe for headless / pre-DOM setup)", () => {
    const reg = createRegistry();
    reg.registerBuffer(createStateMachineBuffer());
    reg.registerSystem(createPanelVisibilitySystem({
      bindings: [{ panel: null, isActiveFor: () => true }],
    }));
    const graph = buildExecutionGraph({ id: "test", nodes: [PANEL_VISIBILITY_SYSTEM_ID], registry: reg });
    expect(() => executeGraph(graph, reg, { dt: 1 / 60, now: 0 })).not.toThrow();
  });

  it("custom activeClass works", () => {
    const reg = createRegistry();
    reg.registerBuffer(createStateMachineBuffer());
    const p = makePanel();
    reg.registerSystem(createPanelVisibilitySystem({
      bindings: [{ panel: p, activeClass: "shown", isActiveFor: () => true }],
    }));
    const graph = buildExecutionGraph({ id: "test", nodes: [PANEL_VISIBILITY_SYSTEM_ID], registry: reg });
    executeGraph(graph, reg, { dt: 1 / 60, now: 0 });
    expect(p._classes.has("shown")).toBe(true);
  });
});
