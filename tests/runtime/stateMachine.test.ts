import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  createStateMachineSystem,
  type RuntimeEvent,
  type RuntimeState,
  type StateMachineBufferData,
} from "../../src/runtime/stateMachine";

function synthRebuild() {
  return {
    sceneName: "x",
    pixels: new Uint8ClampedArray(4),
    width: 1,
    height: 1,
    scene: { name: "x", tileSize: 1, labels: [] },
    image: {} as HTMLImageElement,
  };
}

function setup() {
  const reg = createRegistry();
  const sm = createBuffer<StateMachineBufferData>({
    id: "stateMachine",
    description: "FSM state",
    initial: { state: "Running", activeGraph: "Running", activeMode: "Running", pendingEvents: [], pendingLoad: null, pendingRebuild: null, rebuildGeneration: 0 },
  });
  const events = createBuffer<RuntimeEvent[]>({
    id: "events",
    description: "event queue",
    initial: [],
  });
  reg.registerBuffer(sm);
  reg.registerBuffer(events);
  reg.registerSystem(createStateMachineSystem());
  return { reg, sm, events };
}

describe("StateMachineSystem", () => {
  it("transitions Running -> Rebuilding on RebuildRequested", () => {
    const { reg, sm, events } = setup();
    writeBuffer(events, (d) => { d.push({ type: "RebuildRequested", payload: synthRebuild() }); });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(sm).state).toBe("Rebuilding");
    expect(readBuffer(sm).activeGraph).toBe("Rebuilding");
  });

  /**
   * Phase 1b: the SM writes `activeMode` (= the modes-and-modules
   * canonical field) alongside `activeGraph` (= legacy). Both must
   * carry the same string during the transition period. The loop reads
   * `activeMode` and derives the graph from `mode.systems`.
   */
  it("writes activeMode == activeGraph after every transition (Phase 1b)", () => {
    const { reg, sm, events } = setup();
    writeBuffer(events, (d) => { d.push({ type: "RebuildRequested", payload: synthRebuild() }); });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    const s = readBuffer(sm);
    expect(s.activeMode).toBe(s.activeGraph);
    expect(s.activeMode).toBe("Rebuilding");
  });

  /**
   * Phase 1d: mode transitions emit ModeExited(prev) and ModeEntered(next)
   * onto the events buffer. This is how setup/teardown systems hook into
   * the mode lifecycle without dedicated lifecycle callbacks (= per user
   * 2026-05-23: "events as a buffer any system writes to and so it's
   * pretty easy to have the system FSM enable or disable on demand to do
   * event driven transformations").
   */
  it("emits ModeExited(prev) and ModeEntered(next) on transition (Phase 1d)", () => {
    const { reg, events } = setup();
    writeBuffer(events, (d) => { d.push({ type: "RebuildRequested", payload: synthRebuild() }); });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    // Events queued for NEXT tick (= push back onto the events buffer
    // after the SM drains incoming).
    const queued = readBuffer(events);
    const exited = queued.find((e) => e.type === "ModeExited");
    const entered = queued.find((e) => e.type === "ModeEntered");
    expect(exited).toBeDefined();
    expect(entered).toBeDefined();
    if (exited && exited.type === "ModeExited") {
      expect(exited.payload.modeId).toBe("Running");
    }
    if (entered && entered.type === "ModeEntered") {
      expect(entered.payload.modeId).toBe("Rebuilding");
    }
  });

  it("does NOT emit ModeEntered/ModeExited when state doesn't change (Phase 1d)", () => {
    const { reg, sm, events } = setup();
    // No incoming events → no transition → no mode-lifecycle events emitted.
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    const queued = readBuffer(events);
    expect(queued.find((e) => e.type === "ModeEntered")).toBeUndefined();
    expect(queued.find((e) => e.type === "ModeExited")).toBeUndefined();
    expect(readBuffer(sm).state).toBe("Running");
  });

  it("transitions Rebuilding -> Running on WorldReady", () => {
    const { reg, sm, events } = setup();
    writeBuffer(sm, (d) => { d.state = "Rebuilding"; d.activeGraph = "Rebuilding"; });
    writeBuffer(events, (d) => { d.push({ type: "WorldReady" }); });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(sm).state).toBe("Running");
    expect(readBuffer(sm).activeGraph).toBe("Running");
  });

  it("drains incoming events (mode-lifecycle events emitted on transition remain queued)", () => {
    const { reg, sm, events } = setup();
    writeBuffer(events, (d) => {
      d.push({ type: "RebuildRequested", payload: synthRebuild() });
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    // Original incoming RebuildRequested is drained.
    const queued = readBuffer(events);
    expect(queued.find((e) => e.type === "RebuildRequested")).toBeUndefined();
    // Phase 1d: on transition, SM enqueues ModeExited + ModeEntered for
    // next-tick consumers. The events buffer is no longer guaranteed
    // empty after an SM tick that transitioned.
    expect(queued.length).toBe(2);
    expect(queued.map((e) => e.type)).toEqual(["ModeExited", "ModeEntered"]);
    expect(readBuffer(sm).state).toBe("Rebuilding");
  });

  it("ignores unhandled events without failing", () => {
    const { reg, sm, events } = setup();
    writeBuffer(events, (d) => { d.push({ type: "WorldReady" } as unknown as RuntimeEvent); });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    // Running + WorldReady → no transition; state remains Running
    expect(readBuffer(sm).state).toBe("Running");
  });

  it("processes multiple events in a single tick (FIFO)", () => {
    const { reg, sm, events } = setup();
    writeBuffer(events, (d) => {
      d.push({ type: "RebuildRequested", payload: synthRebuild() });
      d.push({ type: "WorldReady" });
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    // Running → Rebuilding (first event) → Running (second event)
    expect(readBuffer(sm).state).toBe("Running");
  });

  it("bumps rebuildGeneration and stores pendingRebuild on Running -> Rebuilding", () => {
    const { reg, sm, events } = setup();
    writeBuffer(events, (d) => {
      d.push({ type: "RebuildRequested", payload: synthRebuild() });
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(sm).rebuildGeneration).toBe(1);
    expect(readBuffer(sm).pendingRebuild?.sceneName).toBe("x");
  });

  it("clears pendingRebuild on Rebuilding -> Running", () => {
    const { reg, sm, events } = setup();
    writeBuffer(sm, (d) => {
      d.state = "Rebuilding";
      d.activeGraph = "Rebuilding";
      d.pendingRebuild = synthRebuild();
    });
    writeBuffer(events, (d) => { d.push({ type: "WorldReady" }); });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(sm).pendingRebuild).toBeNull();
  });

  it("appends transitions into pendingEvents for downstream systems", () => {
    const { reg, sm, events } = setup();
    writeBuffer(events, (d) => {
      d.push({ type: "RebuildRequested", payload: synthRebuild() });
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(sm).pendingEvents.some((e) => e.type === "RebuildRequested")).toBe(true);
  });
});

// Minor type assertion: RuntimeState narrowed
const _stateCheck: RuntimeState = "Rebuilding";
void _stateCheck;
