import type { Buffer, BufferId } from "./buffer";

export type SystemId = string;
export type GraphId = string;

export type BufferAccessMode = "read" | "write" | "readwrite";

export interface BufferAccess {
  id: BufferId;
  access: BufferAccessMode;
}

export interface SystemExecutionContext {
  /** Time delta since previous tick, seconds. */
  dt: number;
  /** Lookup any buffer by id; throws if missing. Typed via the registry. */
  buffer<T>(id: BufferId): Buffer<T>;
  /** Time stamp from the loop start of this tick (performance.now). */
  now: number;
}

export interface SystemDescriptor {
  id: SystemId;
  description: string;
  buffers: BufferAccess[];
  runsAfter?: SystemId[];
  runsBefore?: SystemId[];
  execute: (ctx: SystemExecutionContext) => void;
}
