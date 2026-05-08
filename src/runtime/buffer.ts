/**
 * A named, version-tracked data store.
 *
 * The runtime model: every system reads from and writes to buffers; nothing
 * else is "runtime state." Buffers carry a description so the registry stays
 * grep-friendly for reuse (see CLAUDE.md / docs/REGISTRY.md).
 */

export type BufferId = string;

export interface Buffer<T> {
  readonly id: BufferId;
  readonly description: string;
  /** Bumped on every write. Stale-reads can be detected by snapshotting. */
  version: number;
  data: T;
}

export interface BufferDescriptor<T> {
  id: BufferId;
  description: string;
  initial: T;
}

export function createBuffer<T>(d: BufferDescriptor<T>): Buffer<T> {
  return { id: d.id, description: d.description, version: 0, data: d.initial };
}

export function readBuffer<T>(b: Buffer<T>): T {
  return b.data;
}

/**
 * Mutate a buffer; bumps version. The mutator may return a replacement object
 * (handy for full replacement) or `void` after mutating in place.
 */
export function writeBuffer<T>(b: Buffer<T>, mutate: (data: T) => T | void): void {
  const result = mutate(b.data);
  if (result !== undefined) {
    b.data = result;
  }
  b.version += 1;
}
