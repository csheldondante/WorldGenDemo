import type { Buffer, BufferId } from "./buffer";
import type { ExecutionGraph } from "./graph";
import type { Registry } from "./registry";
import type { SystemExecutionContext } from "./system";

export interface SchedulerExecuteContext {
  dt: number;
  now: number;
}

/**
 * Run an already-validated graph: invoke each system's `execute` in topo order
 * (`graph.order`), passing a context that resolves buffer ids via the registry.
 */
export function executeGraph(
  graph: ExecutionGraph,
  registry: Registry,
  ctx: SchedulerExecuteContext,
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
    sys.execute(sysCtx);
  }
}
