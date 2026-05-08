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
    initial: { state: "Running", activeGraph: "Running", pendingEvents: [], pendingLoad: null, pendingRebuild: null, rebuildGeneration: 0 },
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

  it("transitions Rebuilding -> Running on WorldReady", () => {
    const { reg, sm, events } = setup();
    writeBuffer(sm, (d) => { d.state = "Rebuilding"; d.activeGraph = "Rebuilding"; });
    writeBuffer(events, (d) => { d.push({ type: "WorldReady" }); });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(sm).state).toBe("Running");
    expect(readBuffer(sm).activeGraph).toBe("Running");
  });

  it("drains the event buffer after processing", () => {
    const { reg, sm, events } = setup();
    writeBuffer(events, (d) => {
      d.push({ type: "RebuildRequested", payload: synthRebuild() });
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(events).length).toBe(0);
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
