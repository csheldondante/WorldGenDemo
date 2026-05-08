import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../src/buffers/stateMachine";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "../../src/buffers/event";
import { createStateMachineSystem } from "../../src/runtime/stateMachine";

describe("Builder mode swap", () => {
  function setup() {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());
    return {
      reg,
      sm: reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID),
      events: reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID),
      g: buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg }),
    };
  }

  it("Running + ModeRequested(builder) → Builder, activeGraph='Builder'", () => {
    const { reg, sm, events, g } = setup();
    writeBuffer(sm, (d) => { d.state = "Running"; d.activeGraph = "Running"; });
    writeBuffer(events, (d) => { d.push({ type: "ModeRequested", payload: { mode: "builder" } }); });
    executeGraph(g, reg, { dt: 0, now: 0 });
    const after = readBuffer(sm);
    expect(after.state).toBe("Builder");
    expect(after.activeGraph).toBe("Builder");
  });

  it("Builder + ModeRequested(world) → Running", () => {
    const { reg, sm, events, g } = setup();
    writeBuffer(sm, (d) => { d.state = "Builder"; d.activeGraph = "Builder"; });
    writeBuffer(events, (d) => { d.push({ type: "ModeRequested", payload: { mode: "world" } }); });
    executeGraph(g, reg, { dt: 0, now: 0 });
    const after = readBuffer(sm);
    expect(after.state).toBe("Running");
    expect(after.activeGraph).toBe("Running");
  });

  it("ModeRequested(world) while in Loading is ignored (no transition)", () => {
    const { reg, sm, events, g } = setup();
    // sm.state defaults to Startup; put it into Loading explicitly
    writeBuffer(sm, (d) => { d.state = "Loading"; d.activeGraph = "Loading"; });
    writeBuffer(events, (d) => { d.push({ type: "ModeRequested", payload: { mode: "builder" } }); });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(sm).state).toBe("Loading"); // unchanged
  });

  it("ModeRequested(builder) with mode='builder' guard fires; mode='world' from Running ignored", () => {
    const { reg, sm, events, g } = setup();
    writeBuffer(sm, (d) => { d.state = "Running"; d.activeGraph = "Running"; });
    // Wrong direction: mode='world' while in Running shouldn't transition (no rule).
    writeBuffer(events, (d) => { d.push({ type: "ModeRequested", payload: { mode: "world" } }); });
    executeGraph(g, reg, { dt: 0, now: 0 });
    expect(readBuffer(sm).state).toBe("Running");
  });

  it("Builder + RebuildRequested → Rebuilding (Send-to-World)", () => {
    const { reg, sm, events, g } = setup();
    writeBuffer(sm, (d) => { d.state = "Builder"; d.activeGraph = "Builder"; });
    const payload = {
      sceneName: "painted-1",
      pixels: new Uint8ClampedArray(0),
      width: 0,
      height: 0,
      scene: { name: "painted-1", tileSize: 1, labels: [] },
      image: {} as HTMLImageElement,
    };
    writeBuffer(events, (d) => { d.push({ type: "RebuildRequested", payload }); });
    executeGraph(g, reg, { dt: 0, now: 0 });
    const after = readBuffer(sm);
    expect(after.state).toBe("Rebuilding");
    expect(after.activeGraph).toBe("Rebuilding");
    expect(after.pendingRebuild?.sceneName).toBe("painted-1");
  });
});
