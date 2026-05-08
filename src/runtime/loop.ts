import type { Registry } from "./registry";
import { readBuffer } from "./buffer";
import { executeGraph } from "./scheduler";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "./stateMachine";

export interface LoopHandle {
  stop(): void;
}

/**
 * Start the rAF-driven runtime loop. Each tick:
 *   1. Read activeGraph from StateMachineBuffer.
 *   2. Execute that graph in topo order via the scheduler.
 *
 * Pre-condition: every graph the SM might choose has been registered
 * and validated (`buildExecutionGraph`).
 */
export function startLoop(registry: Registry): LoopHandle {
  let stopped = false;
  let last = performance.now();

  function tick() {
    if (stopped) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const smBuf = registry.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    const graphId = readBuffer(smBuf).activeGraph;
    const graph = registry.getGraph(graphId);
    executeGraph(graph, registry, { dt, now });

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return {
    stop() { stopped = true; },
  };
}
