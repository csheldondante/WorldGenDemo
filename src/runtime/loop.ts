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

/** Physics tick rate. Headless scenario tests (`runBufferTest`) use the same
 *  value, so browser playback at this dt produces the same trajectory tick-
 *  for-tick as vitest. */
const STEP_DT = 1 / 60;
/** Cap on how many physics ticks one rAF can consume. Prevents the spiral-of-
 *  death when the tab was backgrounded for a long time (or hit a long stall):
 *  we drop accumulated time rather than try to catch up by running hundreds of
 *  ticks in one frame. */
const MAX_STEPS_PER_FRAME = 5;

/**
 * Start the rAF-driven runtime loop. Each rAF:
 *   1. Add elapsed wall-clock time to an accumulator (clamped to
 *      MAX_STEPS_PER_FRAME × STEP_DT).
 *   2. While the accumulator holds at least one STEP_DT, read activeGraph
 *      from StateMachineBuffer and execute it at fixed dt = STEP_DT.
 *
 * Physics is locked to STEP_DT regardless of refresh rate. Render is part
 * of the active graph today, so it fires once per physics tick (rate-
 * limited to STEP_DT). Full render decoupling (render once per rAF with
 * sub-tick interpolation) would require splitting the Running graph into
 * physics + render halves and is deferred.
 *
 * Determinism: at fixed STEP_DT browser playback matches the headless
 * vitest scenario suite (`tests/scenarios/baselines.test.ts`) tick-for-
 * tick. Visual scenario review is now reproducible.
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
  let accumulator = 0;
  let tickIdx = 0;

  function tick() {
    if (stopped) return;
    const now = performance.now();
    const elapsed = (now - last) / 1000;
    last = now;
    // Cap the time-step we accept this rAF. Without this, a backgrounded tab
    // returning after 10s would try to run 600 ticks in one frame.
    accumulator += Math.min(MAX_STEPS_PER_FRAME * STEP_DT, elapsed);

    let stepsThisFrame = 0;
    while (accumulator >= STEP_DT && stepsThisFrame < MAX_STEPS_PER_FRAME) {
      try {
        const smBuf = registry.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
        const graphId = readBuffer(smBuf).activeGraph;
        const graph = registry.getGraph(graphId);
        // `now` exposed to systems is derived from tickIdx, NOT wall-clock —
        // so systems that timestamp by `ctx.now` see a deterministic, fixed-
        // dt-derived clock. Same convention as runBufferTest.
        const tickNow = tickIdx * STEP_DT * 1000;
        executeGraph(graph, registry, { dt: STEP_DT, now: tickNow }, (sysId, err) => {
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
        // Errors at the loop level (e.g. unregistered active graph) are
        // fatal-ish; log and keep going so devtools can grab the trace.
        // eslint-disable-next-line no-console
        console.error("[runtime] tick failed:", err);
      }
      accumulator -= STEP_DT;
      tickIdx += 1;
      stepsThisFrame += 1;
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return {
    stop() { stopped = true; },
  };
}
