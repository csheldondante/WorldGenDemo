import { Dag } from "../lib/dag";
import type { Registry } from "./registry";
import type { GraphId, SystemId } from "./system";

export interface GraphEdge {
  from: SystemId;
  to: SystemId;
  reason: string;
}

/** Validated, topo-sorted execution graph. Data, not behavior. */
export interface ExecutionGraph {
  id: GraphId;
  nodes: SystemId[];
  edges: GraphEdge[];
  order: SystemId[];
}

export interface BuildGraphInput {
  id: GraphId;
  nodes: SystemId[];
  registry: Registry;
}

/**
 * Validate + topo-sort a system list into an ExecutionGraph.
 *
 * Validation: every system registered, every declared buffer registered,
 * write/write and read/write hazards covered by runsAfter/runsBefore ordering.
 * Throws on the first failure with a message naming the offenders.
 */
export function buildExecutionGraph(input: BuildGraphInput): ExecutionGraph {
  const { id, nodes, registry } = input;

  // Validate node registration
  for (const sysId of nodes) {
    if (!registry.hasSystem(sysId)) {
      throw new Error(`graph "${id}": system not registered: ${sysId}`);
    }
  }

  // Validate buffer references for each system in this graph
  for (const sysId of nodes) {
    const sys = registry.getSystem(sysId);
    for (const ba of sys.buffers) {
      if (!registry.hasBuffer(ba.id)) {
        throw new Error(`graph "${id}": system "${sysId}" references unregistered buffer "${ba.id}"`);
      }
    }
  }

  // Build the DAG with explicit-ordering edges (runsAfter, runsBefore).
  const dag = new Dag<SystemId>();
  for (const sysId of nodes) dag.addNode(sysId);

  const inGraph = new Set(nodes);
  const edges: GraphEdge[] = [];
  function addEdge(from: SystemId, to: SystemId, reason: string) {
    if (!inGraph.has(from) || !inGraph.has(to)) return;
    if (Object.is(from, to)) return;
    if (dag.hasEdge(from, to)) return;
    dag.addEdge(from, to, reason);
    edges.push({ from, to, reason });
  }
  for (const sysId of nodes) {
    const s = registry.getSystem(sysId);
    if (s.runsAfter) for (const a of s.runsAfter) addEdge(a, sysId, "runsAfter");
    if (s.runsBefore) for (const b of s.runsBefore) addEdge(sysId, b, "runsBefore");
  }

  // Hazard validation:
  // For each buffer, group systems by access mode in this graph.
  // - Two writers must be ordered (one runsAfter the other, transitively).
  // - A read+write pair on the same buffer must be ordered.
  const writers = new Map<string, SystemId[]>();
  const readers = new Map<string, SystemId[]>();
  for (const sysId of nodes) {
    const s = registry.getSystem(sysId);
    for (const ba of s.buffers) {
      if (ba.access === "write" || ba.access === "readwrite") {
        const a = writers.get(ba.id) ?? [];
        a.push(sysId);
        writers.set(ba.id, a);
      }
      if (ba.access === "read" || ba.access === "readwrite") {
        const a = readers.get(ba.id) ?? [];
        a.push(sysId);
        readers.set(ba.id, a);
      }
    }
  }

  // Pre-compute reachability via the *current* DAG before topo (acyclicity confirmed below)
  function reachable(from: SystemId, to: SystemId): boolean {
    if (Object.is(from, to)) return true;
    return dag.descendants(from).has(to);
  }
  function ordered(a: SystemId, b: SystemId): boolean {
    return reachable(a, b) || reachable(b, a);
  }

  // Two writers
  for (const [bufId, ws] of writers) {
    for (let i = 0; i < ws.length; i++) {
      for (let j = i + 1; j < ws.length; j++) {
        if (!ordered(ws[i], ws[j])) {
          throw new Error(
            `graph "${id}": write/write hazard on buffer "${bufId}" between systems "${ws[i]}" and "${ws[j]}" — add runsAfter or runsBefore to disambiguate`,
          );
        }
      }
    }
  }
  // Read + write pairs (skip reader == writer; that's a single readwrite system)
  for (const [bufId, rs] of readers) {
    const ws = writers.get(bufId) ?? [];
    for (const r of rs) {
      for (const w of ws) {
        if (Object.is(r, w)) continue;
        if (!ordered(r, w)) {
          throw new Error(
            `graph "${id}": read/write hazard on buffer "${bufId}" between reader "${r}" and writer "${w}" — add runsAfter or runsBefore to disambiguate`,
          );
        }
      }
    }
  }

  // Topo sort (cycle check happens here)
  const order = dag.topoSort();

  return { id, nodes: [...nodes], edges, order };
}
