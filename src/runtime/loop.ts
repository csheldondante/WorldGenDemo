import type { Registry } from "./registry";
import { readBuffer, writeBuffer } from "./buffer";
import { executeGraph } from "./scheduler";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "./stateMachine";

export interface LoopHandle {
  stop(): void;
}

const TIMING_BUFFER_ID_LOCAL = "timing"; // avoid circular import on src/buffers/timing

/**
 * Start the rAF-driven runtime loop. Each tick:
 *   1. Read activeGraph from StateMachineBuffer.
 *   2. Execute that graph in topo order via the scheduler.
 *
 * Pre-condition: every graph the SM might choose has been registered
 * and validated (`buildExecutionGraph`).
 *
 * System errors thrown during execute are caught: they're written into
 * TimingBuffer.warnings (rendered by HudSystem) AND logged to the console.
 * The loop survives so the user sees a recoverable error rather than a
 * frozen page.
 */
export function startLoop(registry: Registry): LoopHandle {
  let stopped = false;
  let last = performance.now();

  function tick() {
    if (stopped) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    try {
      const smBuf = registry.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
      const graphId = readBuffer(smBuf).activeGraph;
      const graph = registry.getGraph(graphId);
      executeGraph(graph, registry, { dt, now }, (sysId, err) => {
        // eslint-disable-next-line no-console
        console.error(`[runtime] system "${sysId}" threw:`, err);
        if (registry.hasBuffer(TIMING_BUFFER_ID_LOCAL)) {
          const t = registry.getBuffer<{ warnings: string[] }>(TIMING_BUFFER_ID_LOCAL);
          const msg = `system "${sysId}" error: ${(err as Error).message}`;
          writeBuffer(t, (d) => {
            if (!d.warnings.includes(msg)) d.warnings = [...d.warnings, msg];
          });
        }
      });
    } catch (err) {
      // Errors at the loop level (e.g. unregistered active graph) are fatal-ish;
      // log and keep going so devtools can grab the trace.
      // eslint-disable-next-line no-console
      console.error("[runtime] tick failed:", err);
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return {
    stop() { stopped = true; },
  };
}
