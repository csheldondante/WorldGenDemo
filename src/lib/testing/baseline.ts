/**
 * Baseline (snapshot) regression testing.
 *
 * Pattern: for any pure transformation `f(input) -> output`, capture a known
 * input and the expected output. On subsequent runs, compare current output
 * to the stored baseline. Any unintended change shows up as a precise diff
 * — you see exactly what behavior changed and can manually validate.
 *
 * Vitest's built-in `toMatchSnapshot()` is the underlying mechanism. This
 * module wraps it for our use cases and adds a numeric tolerance comparator
 * (so we can baseline floating-point pipelines without spurious diffs from
 * tiny FP noise).
 *
 * Usage in a test:
 *   import { expectBaselined } from "../../src/lib/testing/baseline";
 *   expectBaselined("parseBitmap-tiny", parseResult);
 *
 * The first time this runs, vitest writes the snapshot file. Subsequent
 * runs diff against it. Update with `npx vitest run --update`.
 */

import { expect } from "vitest";

/**
 * Strict deep-equal snapshot. Use for output you expect to be byte-identical
 * across runs (integers, strings, structural data).
 */
export function expectBaselined<T>(name: string, value: T): void {
  expect({ [name]: serialize(value) }).toMatchSnapshot();
}

/**
 * Snapshot with numeric tolerance. Floats are rounded to `decimals` (default 4)
 * before serialization, so tiny FP variations (e.g., from order-of-operations
 * changes) don't trigger a diff. Real behavior changes still do.
 */
export function expectBaselinedApprox<T>(name: string, value: T, decimals = 4): void {
  expect({ [name]: serialize(value, { roundNumbersTo: decimals }) }).toMatchSnapshot();
}

interface SerializeOptions {
  /** Round all numbers to this many decimal places. Disable with `null`. */
  roundNumbersTo?: number | null;
  /** Maximum nesting depth before truncating. */
  maxDepth?: number;
}

/**
 * Recursive serializer that handles typed arrays, Maps, and Sets — none of
 * which `JSON.stringify` round-trips. Output is plain JSON-friendly objects
 * so vitest's snapshot serializer produces clean diffs.
 */
export function serialize(value: unknown, opts: SerializeOptions = {}): unknown {
  const round = opts.roundNumbersTo ?? null;
  const maxDepth = opts.maxDepth ?? 32;

  function rec(v: unknown, depth: number): unknown {
    if (depth > maxDepth) return "[max-depth]";
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === "number") {
      if (round === null || !Number.isFinite(v as number)) return v;
      const f = Math.pow(10, round);
      return Math.round((v as number) * f) / f;
    }
    if (t === "string" || t === "boolean") return v;
    if (t === "bigint") return `${(v as bigint).toString()}n`;
    if (typeof (v as { byteLength?: unknown }).byteLength === "number" && ArrayBuffer.isView(v as ArrayBufferView)) {
      // typed array: capture as { kind, length, sample } — sampling so we get a stable
      // diff for large buffers without storing megabytes.
      const arr = v as ArrayBufferView & { length: number };
      const data: number[] = [];
      const a = arr as unknown as { [i: number]: number; length: number };
      const limit = Math.min(arr.length, 256);
      for (let i = 0; i < limit; i++) {
        const n = a[i];
        if (round !== null && typeof n === "number") {
          const f = Math.pow(10, round);
          data.push(Math.round(n * f) / f);
        } else {
          data.push(n);
        }
      }
      const summary: { kind: string; length: number; data: number[]; truncated?: true } = {
        kind: (v as { constructor: { name: string } }).constructor.name,
        length: arr.length,
        data,
      };
      if (arr.length > limit) summary.truncated = true;
      return summary;
    }
    if (Array.isArray(v)) return v.map((x) => rec(x, depth + 1));
    if (v instanceof Map) {
      const obj: Record<string, unknown> = {};
      for (const [k, val] of v) obj[String(k)] = rec(val, depth + 1);
      return { __map: obj };
    }
    if (v instanceof Set) {
      return { __set: Array.from(v).map((x) => rec(x, depth + 1)) };
    }
    if (t === "object") {
      const obj: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        obj[k] = rec((v as Record<string, unknown>)[k], depth + 1);
      }
      return obj;
    }
    return String(v);
  }
  return rec(value, 0);
}
