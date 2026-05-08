import type { Buffer, BufferId } from "./buffer";
import type { SystemDescriptor, SystemId, GraphId } from "./system";
import type { ExecutionGraph } from "./graph";

export interface Registry {
  registerBuffer<T>(buf: Buffer<T>): void;
  registerSystem(sys: SystemDescriptor): void;
  registerGraph(graph: ExecutionGraph): void;
  getBuffer<T>(id: BufferId): Buffer<T>;
  hasBuffer(id: BufferId): boolean;
  getSystem(id: SystemId): SystemDescriptor;
  hasSystem(id: SystemId): boolean;
  getGraph(id: GraphId): ExecutionGraph;
  hasGraph(id: GraphId): boolean;
  listBuffers(): Buffer<unknown>[];
  listSystems(): SystemDescriptor[];
  listGraphs(): ExecutionGraph[];
}

export function createRegistry(): Registry {
  const buffers = new Map<BufferId, Buffer<unknown>>();
  const systems = new Map<SystemId, SystemDescriptor>();
  const graphs = new Map<GraphId, ExecutionGraph>();
  // Insertion order for stable listing
  const bufferOrder: BufferId[] = [];
  const systemOrder: SystemId[] = [];
  const graphOrder: GraphId[] = [];

  return {
    registerBuffer(buf) {
      if (buffers.has(buf.id)) throw new Error(`duplicate buffer id: ${buf.id}`);
      buffers.set(buf.id, buf as Buffer<unknown>);
      bufferOrder.push(buf.id);
    },
    registerSystem(sys) {
      if (systems.has(sys.id)) throw new Error(`duplicate system id: ${sys.id}`);
      systems.set(sys.id, sys);
      systemOrder.push(sys.id);
    },
    registerGraph(graph) {
      if (graphs.has(graph.id)) throw new Error(`duplicate graph id: ${graph.id}`);
      graphs.set(graph.id, graph);
      graphOrder.push(graph.id);
    },
    getBuffer<T>(id: BufferId): Buffer<T> {
      const b = buffers.get(id);
      if (!b) throw new Error(`buffer not registered: ${id}`);
      return b as Buffer<T>;
    },
    hasBuffer: (id) => buffers.has(id),
    getSystem(id) {
      const s = systems.get(id);
      if (!s) throw new Error(`system not registered: ${id}`);
      return s;
    },
    hasSystem: (id) => systems.has(id),
    getGraph(id) {
      const g = graphs.get(id);
      if (!g) throw new Error(`graph not registered: ${id}`);
      return g;
    },
    hasGraph: (id) => graphs.has(id),
    listBuffers: () => bufferOrder.map((id) => buffers.get(id)!),
    listSystems: () => systemOrder.map((id) => systems.get(id)!),
    listGraphs: () => graphOrder.map((id) => graphs.get(id)!),
  };
}
