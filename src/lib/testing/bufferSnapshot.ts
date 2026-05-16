/**
 * Canonical buffer snapshot serializer.
 *
 * Every system in WorldGenDemo is a transformation of named buffers; tests
 * compare buffer values value-by-value. This module is the deterministic
 * encoder: given a buffer's `data` field, produce a JSON-shaped tree where:
 *
 *   - `Map<K, V>`    →  sorted-by-key object (`{ [stringKey]: encode(V) }`).
 *   - `Set<V>`       →  sorted array.
 *   - Typed arrays   →  regular arrays (no metadata; same values).
 *   - Plain arrays   →  preserved in insertion order — index IS the identity.
 *   - Plain objects  →  object with KEYS SORTED so JSON.stringify output is canonical.
 *   - Primitives     →  passthrough (number, string, boolean, null).
 *   - undefined      →  becomes null (JSON-safe).
 *
 * Why each rule:
 *   - Maps/Sets: production code iterates in insertion order, which depends on
 *     spawn/death sequence. Sorting on output means iteration-order changes
 *     never leak into baselines.
 *   - Plain arrays: order is THE identity (event queues, FSM transition logs,
 *     skeleton bone indices matching rig parent IDs).
 *   - Object keys: sorting normalizes textual diffs in baseline JSON files.
 *
 * Refuses to encode class instances with methods. Concretely: if a value is
 * a non-plain object (has a non-Object prototype) it throws. RenderRefs,
 * SurfaceProvider, THREE.* objects fail this check — they need explicit
 * exclusion at the test level.
 *
 * `restoreBufferData(snapshot)` is the inverse: rebuilds Maps/Sets from their
 * encoded forms (best-effort — Map key types and Set element types must be
 * inferable from the encoded values; we recover integer keys when the string
 * key parses as an integer, else leave as string).
 *
 * Lib-layer: no runtime / DOM / Three.js deps. Pure functions.
 */

/** JSON-shaped serializable value tree. */
export type SnapshotValue =
  | null
  | boolean
  | number
  | string
  | SnapshotValue[]
  | { [key: string]: SnapshotValue };

/** A snapshot of one buffer's data plus the buffer's id. */
export interface SerializedBuffer {
  bufferId: string;
  data: SnapshotValue;
}

/** Sentinel tags used by the encoder so restore can recover Map / Set. */
const MAP_TAG = "__map__";
const SET_TAG = "__set__";

/**
 * Snapshot a buffer's data tree. Throws if it encounters a non-plain object
 * (class instance) — those buffers must be excluded at the test layer.
 */
export function snapshotBufferData(data: unknown): SnapshotValue {
  return encode(data, []);
}

/** Bundle the buffer id + encoded data — what tests serialize to disk. */
export function snapshotBuffer(bufferId: string, data: unknown): SerializedBuffer {
  return { bufferId, data: snapshotBufferData(data) };
}

/**
 * Inverse of `snapshotBufferData` — rebuild Maps/Sets from their tagged form.
 * Plain objects and arrays come through structurally identical to the live form.
 *
 * Integer Map keys (encoded as strings) are recovered if the key parses
 * losslessly. Numeric Set members keep their JSON number type.
 */
export function restoreBufferData(snapshot: SnapshotValue): unknown {
  return decode(snapshot);
}

// ─────────────────────────────────────────────────────────────────────────
// Encoder

function encode(v: unknown, path: (string | number)[]): SnapshotValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error(
        `snapshot at ${formatPath(path)}: cannot encode non-finite number (${v}). ` +
          "If this is expected, exclude this leaf with a per-path override.",
      );
    }
    return v;
  }
  if (typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") {
    throw new Error(`snapshot at ${formatPath(path)}: unsupported type ${typeof v}`);
  }

  // Map → sorted-by-key object with tag.
  if (v instanceof Map) {
    const entries: [string, SnapshotValue][] = [];
    for (const [k, val] of v.entries()) {
      const keyStr = mapKeyToString(k, path);
      entries.push([keyStr, encode(val, [...path, keyStr])]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const obj: Record<string, SnapshotValue> = { [MAP_TAG]: true };
    for (const [k, val] of entries) obj[k] = val;
    return obj;
  }

  // Set → sorted array with tag wrapper.
  if (v instanceof Set) {
    const arr: SnapshotValue[] = [];
    for (const item of v.values()) {
      arr.push(encode(item, [...path, "*"]));
    }
    arr.sort((a, b) => compareForSort(a, b));
    return { [SET_TAG]: true, values: arr };
  }

  // Typed arrays (Float32Array, Int32Array, Uint8Array, etc.) → plain array.
  // We don't preserve the typed-array kind; tests compare the values, not the
  // storage class. Restore brings them back as plain `number[]` — if a
  // downstream consumer needs Float32Array, the test-side restore would
  // re-wrap (out of scope here).
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    const ta = v as unknown as ArrayLike<number>;
    const out: number[] = [];
    for (let i = 0; i < ta.length; i++) {
      const n = ta[i];
      out.push(Number.isFinite(n) ? n : 0); // typed arrays default 0 for NaN encoding; rare in our data
    }
    return out;
  }

  // Plain arrays → preserved in order. Index IS identity.
  if (Array.isArray(v)) {
    return v.map((item, i) => encode(item, [...path, i]));
  }

  // Plain objects → keys sorted for canonical output.
  if (isPlainObject(v)) {
    const out: Record<string, SnapshotValue> = {};
    const keys = Object.keys(v).sort();
    for (const k of keys) {
      out[k] = encode((v as Record<string, unknown>)[k], [...path, k]);
    }
    return out;
  }

  // Anything else (class instance with non-Object prototype, host object)
  // we refuse. Caller must exclude the buffer at the test layer.
  const proto = Object.getPrototypeOf(v);
  const protoName = proto?.constructor?.name ?? "(unknown)";
  throw new Error(
    `snapshot at ${formatPath(path)}: refusing to encode class instance of "${protoName}". ` +
      "Buffers holding non-data references (THREE.*, DOM elements, SurfaceProvider, etc.) " +
      "must be excluded from the test's output.snapshot list.",
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Decoder

function decode(v: SnapshotValue): unknown {
  if (v === null) return null;
  if (typeof v === "boolean" || typeof v === "string" || typeof v === "number") return v;
  if (Array.isArray(v)) return v.map(decode);
  // Tagged Map / Set?
  if (typeof v === "object" && v !== null && MAP_TAG in v) {
    const m = new Map<unknown, unknown>();
    const obj = v as Record<string, SnapshotValue>;
    for (const [k, val] of Object.entries(obj)) {
      if (k === MAP_TAG) continue;
      m.set(maybeIntegerKey(k), decode(val));
    }
    return m;
  }
  if (typeof v === "object" && v !== null && SET_TAG in v) {
    const s = new Set<unknown>();
    const obj = v as { values: SnapshotValue[] };
    for (const item of obj.values) s.add(decode(item));
    return s;
  }
  // Plain object.
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, SnapshotValue>)) {
    out[k] = decode(val);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function mapKeyToString(k: unknown, path: (string | number)[]): string {
  if (typeof k === "string") return k;
  if (typeof k === "number") {
    if (!Number.isFinite(k)) {
      throw new Error(`snapshot at ${formatPath(path)}: Map has non-finite numeric key (${k})`);
    }
    return String(k);
  }
  if (typeof k === "boolean") return String(k);
  throw new Error(
    `snapshot at ${formatPath(path)}: Map key of type ${typeof k} not supported (only string/number/boolean)`,
  );
}

function maybeIntegerKey(s: string): string | number {
  // Recover integer keys (the common case for `Map<EntityId, X>` where EntityId is number).
  const n = Number(s);
  if (Number.isFinite(n) && String(n) === s) return n;
  return s;
}

/**
 * Sort key for Set serialization. Sets are sorted so iteration order in
 * source code never affects the baseline. Numbers compare numerically;
 * strings lexicographically; other types fall back to JSON form.
 */
function compareForSort(a: SnapshotValue, b: SnapshotValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  // Mixed or structural: fall back to JSON form. Stable across runs because
  // the encoder is deterministic.
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

export function formatPath(path: (string | number)[]): string {
  if (path.length === 0) return "<root>";
  return path
    .map((seg, i) => (typeof seg === "number" ? `[${seg}]` : i === 0 ? seg : `.${seg}`))
    .join("");
}
