import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { Buffer } from "../../runtime/buffer";
import type { SystemExecutionContext } from "../../runtime/system";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID, type TimingBufferData } from "../../buffers/timing";

/**
 * Run a pipeline stage's body exactly once per rebuild generation.
 * Returns whether the body ran.
 */
export function runOncePerRebuild(opts: {
  ctx: SystemExecutionContext;
  state: { lastGen: number };
  stageName: string;
  body: (sm: StateMachineBufferData) => void;
}): boolean {
  const sm = readBuffer(opts.ctx.buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
  if (sm.state !== "Rebuilding") return false;
  if (sm.rebuildGeneration === opts.state.lastGen) return false;
  if (!sm.pendingRebuild) return false;

  const t0 = performance.now();
  opts.body(sm);
  const elapsed = performance.now() - t0;
  opts.state.lastGen = sm.rebuildGeneration;

  const timing = opts.ctx.buffer<TimingBufferData>(TIMING_BUFFER_ID);
  writeBuffer(timing, (d) => { d.stages[opts.stageName] = elapsed; });
  return true;
}

export function bufferOf<T>(ctx: SystemExecutionContext, id: string): Buffer<T> {
  return ctx.buffer<T>(id);
}
