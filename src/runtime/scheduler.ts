import type { Buffer, BufferId } from "./buffer";
import type { ExecutionGraph } from "./graph";
import type { Registry } from "./registry";
import type { SystemExecutionContext } from "./system";
import { IS_DEV } from "./dev";

export interface SchedulerExecuteContext {
  dt: number;
  now: number;
}

/**
 * Run an already-validated graph: invoke each system's `execute` in topo order
 * (`graph.order`), passing a context that resolves buffer ids via the registry.
 *
 * If a system throws, the error is caught and surfaced to the optional
 * `onError` handler; subsequent systems in the same tick still run, and the
 * loop survives. (Per V0 doc: contracts are validated up-front; runtime
 * exceptions are bugs to surface, not reasons to halt the world.)
 */
export function executeGraph(
  graph: ExecutionGraph,
  registry: Registry,
  ctx: SchedulerExecuteContext,
  onError?: (sysId: string, err: unknown) => void,
): void {
  const sysCtx: SystemExecutionContext = {
    dt: ctx.dt,
    now: ctx.now,
    buffer<T>(id: BufferId): Buffer<T> {
      return registry.getBuffer<T>(id);
    },
  };
  for (const sysId of graph.order) {
    const sys = registry.getSystem(sysId);
    try {
      sys.execute(sysCtx);
    } catch (err) {
      // Always notify the handler / log
      if (onError) onError(sysId, err);
      else {
        // eslint-disable-next-line no-console
        console.error(`[scheduler] system "${sysId}" threw during execute:`, err);
      }
      // In dev: re-throw so the rAF chain dies and devtools shows a stack
      // immediately. In prod: swallow so the world keeps running.
      if (IS_DEV) throw err;
    }
  }
}
