/**
 * Generic DAG primitive used by the runtime ExecutionGraph and any other
 * dependency-graph need (asset graphs, behavior trees, build pipelines).
 *
 * Runtime-agnostic: must not import from src/runtime/ or src/systems/.
 */

export class DagCycleError extends Error {
  constructor(public readonly cycle: readonly unknown[]) {
    super(`cycle detected: ${cycle.map(String).join(" -> ")}`);
    this.name = "DagCycleError";
  }
}

export interface DagEdge<NodeId> {
  from: NodeId;
  to: NodeId;
  reason?: string;
}

export class Dag<NodeId> {
  private readonly _nodes = new Set<NodeId>();
  private readonly _out = new Map<NodeId, Map<NodeId, string | undefined>>();
  private readonly _in = new Map<NodeId, Set<NodeId>>();

  addNode(id: NodeId): void {
    if (this._nodes.has(id)) return;
    this._nodes.add(id);
    this._out.set(id, new Map());
    this._in.set(id, new Set());
  }

  addEdge(from: NodeId, to: NodeId, reason?: string): void {
    if (Object.is(from, to)) {
      throw new Error(`self-loop not allowed: ${String(from)}`);
    }
    this.addNode(from);
    this.addNode(to);
    const out = this._out.get(from)!;
    if (!out.has(to)) {
      out.set(to, reason);
      this._in.get(to)!.add(from);
    }
  }

  hasNode(id: NodeId): boolean {
    return this._nodes.has(id);
  }

  hasEdge(from: NodeId, to: NodeId): boolean {
    return this._out.get(from)?.has(to) ?? false;
  }

  nodes(): NodeId[] {
    return Array.from(this._nodes);
  }

  edges(): DagEdge<NodeId>[] {
    const out: DagEdge<NodeId>[] = [];
    for (const [from, dests] of this._out) {
      for (const [to, reason] of dests) {
        out.push({ from, to, reason });
      }
    }
    return out;
  }

  /** Kahn's algorithm. Throws DagCycleError if not acyclic. */
  topoSort(): NodeId[] {
    const indeg = new Map<NodeId, number>();
    for (const id of this._nodes) indeg.set(id, this._in.get(id)!.size);
    const q: NodeId[] = [];
    for (const [id, n] of indeg) if (n === 0) q.push(id);
    const order: NodeId[] = [];
    while (q.length) {
      const id = q.shift()!;
      order.push(id);
      for (const next of this._out.get(id)!.keys()) {
        const d = (indeg.get(next) ?? 0) - 1;
        indeg.set(next, d);
        if (d === 0) q.push(next);
      }
    }
    if (order.length !== this._nodes.size) {
      const remaining = new Set(this._nodes);
      for (const id of order) remaining.delete(id);
      throw new DagCycleError(Array.from(remaining));
    }
    return order;
  }

  /** Tarjan's strongly connected components; SCCs of size >= 2 (or self-loops) are cycles. */
  findCycles(): NodeId[][] {
    let index = 0;
    const stack: NodeId[] = [];
    const onStack = new Set<NodeId>();
    const indices = new Map<NodeId, number>();
    const lowlinks = new Map<NodeId, number>();
    const sccs: NodeId[][] = [];

    const strongconnect = (v: NodeId): void => {
      indices.set(v, index);
      lowlinks.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of this._out.get(v)!.keys()) {
        if (!indices.has(w)) {
          strongconnect(w);
          lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
        } else if (onStack.has(w)) {
          lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
        }
      }

      if (lowlinks.get(v) === indices.get(v)) {
        const comp: NodeId[] = [];
        let w: NodeId;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (!Object.is(w, v));
        if (comp.length >= 2) sccs.push(comp);
      }
    };

    for (const v of this._nodes) {
      if (!indices.has(v)) strongconnect(v);
    }
    return sccs;
  }

  ancestors(id: NodeId): Set<NodeId> {
    const out = new Set<NodeId>();
    const stack: NodeId[] = [...(this._in.get(id) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      for (const p of this._in.get(cur) ?? []) stack.push(p);
    }
    return out;
  }

  descendants(id: NodeId): Set<NodeId> {
    const out = new Set<NodeId>();
    const stack: NodeId[] = [...(this._out.get(id)?.keys() ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (out.has(cur)) continue;
      out.add(cur);
      for (const c of this._out.get(cur)?.keys() ?? []) stack.push(c);
    }
    return out;
  }
}
