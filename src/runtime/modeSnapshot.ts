/**
 * Mode-level state snapshotting.
 *
 * `serializeMode(reg, modeId)` captures the current value of every
 * buffer declared by the mode (= ownedBuffers + sharedBuffers, minus
 * any buffers listed in `excludeFromSnapshot`) into a JSON-shaped
 * `ModeSnapshot`. `restoreMode(reg, snapshot)` applies the snapshot
 * back into the registry's buffers.
 *
 * Built on the per-buffer encoder in
 * `src/lib/testing/bufferSnapshot.ts` — which the test framework
 * already uses for scenario baselines. Same JSON dialect; same
 * Map/Set restoration semantics.
 *
 * Use cases:
 *   - Save game / Load game
 *   - Editor save / scene replay / undo
 *   - Hot transition between modes that share projected state
 *   - Inspector mode capturing live runtime state for display
 *
 * See `docs/modes-and-modules.md` for the full architectural target.
 */

import type { Registry } from "./registry";
import type { BufferId } from "./buffer";
import { readBuffer, writeBuffer, type Buffer } from "./buffer";
import {
  snapshotBufferData,
  restoreBufferData,
  type SnapshotValue,
} from "../lib/testing/bufferSnapshot";

export interface ModeSnapshot {
  /** Mode id captured from. The restore step looks up the mode by this
   *  id to determine which buffers to apply the snapshot to. */
  modeId: string;
  /** Buffer id → encoded JSON value. Same dialect as
   *  `src/lib/testing/bufferSnapshot.ts`. */
  buffers: Record<BufferId, SnapshotValue>;
  /** Buffers explicitly excluded from the snapshot (= e.g. render
   *  handles). The restore step must reconstruct these separately. */
  excluded: BufferId[];
}

/**
 * Capture the current buffer state for every buffer declared by the
 * mode. Owned + shared buffers are both included; buffers listed in
 * `mode.excludeFromSnapshot` are skipped (recorded in `excluded` for
 * the restore step's awareness).
 *
 * Throws if the mode id is not registered, or if a declared buffer
 * isn't registered, or if a buffer's data contains a non-serializable
 * value (= class instance with methods, Three.js handle, etc.). In
 * the last case, add the buffer to `excludeFromSnapshot`.
 */
export function serializeMode(reg: Registry, modeId: string): ModeSnapshot {
  const mode = reg.getMode(modeId);
  if (!mode) throw new Error(`serializeMode: mode '${modeId}' is not registered.`);

  const exclude = new Set(mode.excludeFromSnapshot ?? []);
  const all = [...(mode.ownedBuffers ?? []), ...(mode.sharedBuffers ?? [])];

  const buffers: Record<BufferId, SnapshotValue> = {};
  for (const bufId of all) {
    if (exclude.has(bufId)) continue;
    if (!reg.hasBuffer(bufId)) {
      throw new Error(`serializeMode: mode '${modeId}' references unregistered buffer '${bufId}'.`);
    }
    const buf = reg.getBuffer<unknown>(bufId);
    buffers[bufId] = snapshotBufferData(readBuffer(buf));
  }
  return {
    modeId,
    buffers,
    excluded: [...exclude],
  };
}

/**
 * Apply a snapshot's buffer values to the registry. Buffers in the
 * snapshot that aren't registered in `reg` are silently skipped (=
 * forward-compat — a snapshot can mention buffers that don't exist
 * in the current build, the restore tolerates that gracefully).
 *
 * The restored buffer keeps its identity; only its `data` field is
 * replaced. `version` is bumped by `writeBuffer` so downstream
 * readers detect the change.
 */
export function restoreMode(reg: Registry, snapshot: ModeSnapshot): void {
  for (const [bufId, encoded] of Object.entries(snapshot.buffers)) {
    if (!reg.hasBuffer(bufId)) continue;
    const buf = reg.getBuffer<unknown>(bufId) as Buffer<unknown>;
    const restored = restoreBufferData(encoded);
    writeBuffer(buf, () => restored);
  }
}
