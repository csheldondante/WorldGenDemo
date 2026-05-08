import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../src/buffers/stateMachine";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "../../src/buffers/event";
import { createStateMachineSystem } from "../../src/runtime/stateMachine";

function synthRebuild() {
  return {
    sceneName: "x",
    pixels: new Uint8ClampedArray(0),
    width: 0,
    height: 0,
    scene: { name: "x", tileSize: 1, labels: [] },
    image: {} as HTMLImageElement,
  };
}

describe("Graph swap via state machine", () => {
  it("Running + RebuildRequested -> activeGraph='Rebuilding' next tick", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());

    // Put SM into Running first (default initial state is Startup).
    const smBuf = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    writeBuffer(smBuf, (d) => { d.state = "Running"; d.activeGraph = "Running"; });

    const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
    writeBuffer(events, (d) => { d.push({ type: "RebuildRequested", payload: synthRebuild() }); });

    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const sm = readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
    expect(sm.state).toBe("Rebuilding");
    expect(sm.activeGraph).toBe("Rebuilding");
    expect(sm.rebuildGeneration).toBe(1);
  });

  it("Rebuilding + WorldReady -> activeGraph='Running' and pendingRebuild cleared", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());

    const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    writeBuffer(sm, (d) => {
      d.state = "Rebuilding";
      d.activeGraph = "Rebuilding";
      d.pendingRebuild = synthRebuild();
      d.rebuildGeneration = 1;
    });
    writeBuffer(reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID), (d) => { d.push({ type: "WorldReady" }); });

    const g = buildExecutionGraph({ id: "g", nodes: ["stateMachineSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const after = readBuffer(sm);
    expect(after.state).toBe("Running");
    expect(after.activeGraph).toBe("Running");
    expect(after.pendingRebuild).toBeNull();
  });
});
