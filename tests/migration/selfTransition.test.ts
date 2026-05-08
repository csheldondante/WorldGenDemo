import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../src/buffers/stateMachine";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "../../src/buffers/event";
import { createStateMachineSystem } from "../../src/runtime/stateMachine";

/**
 * Boot path: Startup → Loading → Rebuilding → Running.
 * These tests confirm payloads are captured on the relevant transitions
 * and the SM never gets stuck due to a self-transition trap.
 */
describe("Boot transitions and payload capture", () => {
  it("Startup + LoadRequested -> Loading, pendingLoad set", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());
    const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    expect(readBuffer(sm).state).toBe("Startup");

    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "LoadRequested", payload: { sceneName: "canyon-desert" } });
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const after = readBuffer(sm);
    expect(after.state).toBe("Loading");
    expect(after.activeGraph).toBe("Loading");
    expect(after.pendingLoad).toEqual({ sceneName: "canyon-desert" });
  });

  it("Running + LoadRequested -> Loading (re-load while running)", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());
    const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    writeBuffer(sm, (d) => { d.state = "Running"; d.activeGraph = "Running"; });

    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "LoadRequested", payload: { sceneName: "forest-clearing" } });
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const after = readBuffer(sm);
    expect(after.state).toBe("Loading");
    expect(after.pendingLoad).toEqual({ sceneName: "forest-clearing" });
  });

  it("an event with no matching transition does not change state (and does not throw)", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());
    const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    // Startup state has no WorldReady transition. Dispatching it should be a no-op,
    // not a hang or a throw. (warnDev fires; we just don't surface it here.)
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => {
      d.push({ type: "WorldReady" });
    });
    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    expect(() => executeGraph(g, reg, { dt: 0, now: 0 })).not.toThrow();
    expect(readBuffer(sm).state).toBe("Startup");
  });
});
