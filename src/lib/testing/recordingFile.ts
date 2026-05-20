/**
 * Recording file format — a self-contained replay fixture.
 *
 * A `RecordingFile` is everything needed to deterministically reproduce a
 * gameplay slice: the snapshot of every gameplay buffer at record-start, the
 * surface description (heightmap data, since the live `SurfaceProvider` is a
 * class instance and can't be serialized directly), the sparse input timeline,
 * and the metadata (scene name, recorded-at timestamps, tick rate).
 *
 * Anything visual or scene-side (Three.js handles, DOM elements, renderRefs)
 * is reconstructed by the harness rather than serialized. The format is
 * version-tagged so older recordings can be migrated forward.
 *
 * Round-trip determinism: `restoreRecording(serializeRecording(x)).x` must
 * tick to the same end-state buffers as the live x. The round-trip test in
 * `tests/lib/testing/recordingFile.test.ts` is the contract.
 *
 * Lib-layer module: no runtime / DOM / Three.js deps. Pure functions.
 */
import {
  snapshotBufferData,
  restoreBufferData,
  type SnapshotValue,
} from "./bufferSnapshot";
import type { InputFrame } from "../../systems/testing/inputPlayback";

/** Current on-disk version. Bump when the shape changes. */
export const RECORDING_FILE_VERSION = 1;

/** Sentinel strings for Infinity / -Infinity round-trip. */
const POS_INF_TAG = "__inf__";
const NEG_INF_TAG = "__neginf__";

/**
 * Heightmap-surface description. The live surface provider is a class
 * instance with computed normals; we serialize only the inputs (width, height,
 * tileSize, height-field data) and rehydrate the provider on load.
 */
export interface SerializedHeightmap {
  kind: "heightmap";
  /** SurfaceId the live provider used (e.g. "main", "climbTall"). */
  id: string;
  width: number;
  height: number;
  tileSize: number;
  /** Row-major heights, length = width × height. Float32Array values as numbers. */
  data: number[];
}

export interface ScenarioContext {
  /** Scene name from `?map=` if loaded via free play, else null. */
  sceneName: string | null;
  /** Scenario name from `?scenario=` if loaded via the scenario harness, else null. */
  scenarioName: string | null;
  /** ISO-8601 UTC timestamp of when Record was pressed. */
  recordedAtUtc: string;
  /** Scheduler `now` (ms) at the moment of Record. */
  recordedAtMs: number;
  /** Scheduler tick index at the moment of Record (informational; replay restarts at 0). */
  tickIndex: number;
  /** Tick step in seconds. Default 1/60. */
  dtSeconds: number;
}

export interface RecordingFile {
  /** Format version. */
  version: number;
  scenarioContext: ScenarioContext;
  /**
   * Buffer-id → snapshot of that buffer's `data` (encoded by
   * `snapshotBufferData`, with Infinity / -Infinity replaced by string
   * sentinels so the JSON is portable).
   */
  initialBuffers: Record<string, SnapshotValue>;
  /**
   * Surface description if a SurfaceProvider was active at record-start.
   * Null in scenes that don't use a surface (rare today).
   */
  surface: SerializedHeightmap | null;
  /** Sparse input timeline; same format `InputRecordingSystem` already produces. */
  events: InputFrame[];
  /** Total frames captured. */
  frames: number;
}

// ---------------------------------------------------------------------------
// Infinity tagging — buffer snapshot rejects non-finite numbers but profile
// curves use Infinity for "no velocity cap". Walk the encoded tree replacing
// Infinity → sentinel before snapshotBufferData sees it; reverse on restore.
// ---------------------------------------------------------------------------

/** Pre-walks raw `data` and replaces ±Infinity with string sentinels. Returns
 *  a deep-cloned tree safe to pass to `snapshotBufferData`. */
export function tagInfinity(v: unknown): unknown {
  if (typeof v === "number") {
    if (v === Infinity) return POS_INF_TAG;
    if (v === -Infinity) return NEG_INF_TAG;
    return v;
  }
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, val] of v.entries()) out.set(k, tagInfinity(val));
    return out;
  }
  if (v instanceof Set) {
    const out = new Set<unknown>();
    for (const item of v.values()) out.add(tagInfinity(item));
    return out;
  }
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return v; // typed arrays — values can't be Infinity here
  if (Array.isArray(v)) return v.map(tagInfinity);
  const proto = Object.getPrototypeOf(v as object);
  if (proto !== Object.prototype && proto !== null) return v; // class instance — bufferSnapshot will reject; let it
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = tagInfinity(val);
  return out;
}

/** Inverse of `tagInfinity` — walks restored data swapping sentinels back to Infinity. */
export function untagInfinity(v: unknown): unknown {
  if (v === POS_INF_TAG) return Infinity;
  if (v === NEG_INF_TAG) return -Infinity;
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, val] of v.entries()) out.set(k, untagInfinity(val));
    return out;
  }
  if (v instanceof Set) {
    const out = new Set<unknown>();
    for (const item of v.values()) out.add(untagInfinity(item));
    return out;
  }
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return v;
  if (Array.isArray(v)) return v.map(untagInfinity);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = untagInfinity(val);
  return out;
}

// ---------------------------------------------------------------------------
// Convenience helpers used by the world wiring + the test harness.
// ---------------------------------------------------------------------------

/**
 * Encode a single buffer's `data` for inclusion in a recording. Walks the
 * tree first to substitute Infinity sentinels so the bufferSnapshot encoder
 * (which rejects non-finite numbers) accepts the result.
 */
export function snapshotBufferForRecording(data: unknown): SnapshotValue {
  return snapshotBufferData(tagInfinity(data));
}

/** Inverse: snapshot from a recording → live buffer `data` shape. */
export function restoreBufferFromRecording(snapshot: SnapshotValue): unknown {
  return untagInfinity(restoreBufferData(snapshot));
}

/**
 * Build a default UTC-stamped filename for a recording, suitable for the
 * blob-download anchor in the browser. The colons in ISO-8601 are replaced
 * with hyphens because some filesystems (Windows) reject them.
 */
export function defaultRecordingFilename(scene: string | null): string {
  const stem = (scene ?? "recording").replace(/[^a-z0-9_-]/gi, "-");
  const stamp = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "Z");
  return `${stem}-${stamp}.recording.json`;
}
