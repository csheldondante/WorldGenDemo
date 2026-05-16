/**
 * Generic comparator for buffer snapshot trees.
 *
 * Given an actual snapshot tree and a baseline snapshot tree, walks both in
 * parallel and emits one `Flag` for every leaf where the values disagree
 * outside the active tolerance.
 *
 * Default tolerance for numeric leaves is `absolute: 1e-6`. Categorical
 * (string / boolean / null) leaves require exact match. Per-path overrides
 * stored alongside the baseline override the defaults — see the matching
 * semantics in `pickTolerance` below.
 *
 * Why these defaults: in a deterministic test with seeded input and fixed dt,
 * float-noise accumulates very slowly. 1e-6 catches systematic drift while
 * absorbing the chaotic-in-practice but bounded noise of the surface-frame
 * solver, body lean, etc. Per-path overrides are post-hoc — recorded only
 * when the human reviews flags and decides "this path legitimately needs
 * more room."
 *
 * Lib-layer: no runtime deps. Pure functions over JSON-shaped trees.
 */

import { type SnapshotValue, formatPath } from "./bufferSnapshot";

export interface NumericTolerance {
  kind: "numeric";
  /** Absolute tolerance: `|actual - baseline| <= absolute` is OK. */
  absolute?: number;
  /** Optional relative tolerance (combines with absolute via OR). */
  relative?: number;
}

export interface CategoricalTolerance {
  kind: "categorical";
  /** Allowed values; actual must be one of these. */
  allowed: string[];
}

export interface ExactTolerance {
  kind: "exact";
}

export type Tolerance = NumericTolerance | CategoricalTolerance | ExactTolerance;

/** Map of path-glob → tolerance. See `pickTolerance` for glob semantics. */
export type ToleranceOverrides = Record<string, Tolerance>;

export interface CompareOptions {
  /** Default tolerance for numeric leaves with no override. Defaults to `{ kind: "numeric", absolute: 1e-6 }`. */
  defaultNumeric?: NumericTolerance;
  /** Per-path overrides. Most specific match wins. */
  overrides?: ToleranceOverrides;
  /** Per-buffer paths to skip entirely (e.g. timestamps that vary by run). */
  excludePaths?: string[];
}

export interface Flag {
  /** Dotted path including buffer-id prefix, e.g. `"transform.byEntity.1.position.2"`. */
  path: string;
  reason: string;
  /** The baseline value at this leaf, or `"<missing>"` / `"<extra>"`. */
  baseline: SnapshotValue | "<missing>";
  /** The actual value at this leaf, or `"<extra>"` / `"<missing>"`. */
  actual: SnapshotValue | "<missing>";
  /** Tolerance applied at this leaf (after override resolution). */
  tolerance: Tolerance | null;
}

const DEFAULT_NUMERIC: NumericTolerance = { kind: "numeric", absolute: 1e-6 };

/**
 * Compare two snapshot trees. `prefix` is prepended to every flag path —
 * usually the buffer id so flags read like `transform.byEntity.1.position.2`.
 *
 * Walks BOTH trees so we catch keys present in one but not the other.
 */
export function compareSnapshots(
  actual: SnapshotValue,
  baseline: SnapshotValue,
  prefix: string,
  options: CompareOptions = {},
): Flag[] {
  const flags: Flag[] = [];
  const opts: Required<CompareOptions> = {
    defaultNumeric: options.defaultNumeric ?? DEFAULT_NUMERIC,
    overrides: options.overrides ?? {},
    excludePaths: options.excludePaths ?? [],
  };
  const sortedOverrides = Object.entries(opts.overrides).sort(
    // Longest-most-specific first (more dots = deeper specificity); within the
    // same depth, fewer wildcards wins (so an exact path outranks a glob).
    (a, b) => specificityRank(b[0]) - specificityRank(a[0]),
  );
  const excludeSet = compileGlobMatchers(opts.excludePaths);
  walk(actual, baseline, prefix.split(".").filter(Boolean), flags, opts.defaultNumeric, sortedOverrides, excludeSet);
  return flags;
}

function walk(
  actual: SnapshotValue,
  baseline: SnapshotValue,
  path: string[],
  flags: Flag[],
  defaultNumeric: NumericTolerance,
  sortedOverrides: [string, Tolerance][],
  excludeSet: GlobMatcher[],
): void {
  const fullPath = path.join(".");
  if (anyMatch(fullPath, excludeSet)) return;

  // Categorical leaf vs numeric: only compare like-kind.
  const aKind = leafKind(actual);
  const bKind = leafKind(baseline);

  // If both are leaves → comparator.
  if (aKind !== "structural" && bKind !== "structural") {
    const tol = pickTolerance(fullPath, sortedOverrides, defaultNumeric, aKind, bKind);
    const flag = compareLeaf(actual, baseline, fullPath, tol);
    if (flag) flags.push(flag);
    return;
  }

  // Structural mismatch: one is a leaf, one is a structure.
  if (aKind !== bKind && (aKind === "structural" || bKind === "structural")) {
    flags.push({
      path: fullPath,
      reason: `shape mismatch: actual is ${aKind}, baseline is ${bKind}`,
      baseline,
      actual,
      tolerance: null,
    });
    return;
  }

  // Both structures. Could be arrays or objects (Map/Set encoded as tagged objects).
  if (Array.isArray(actual) && Array.isArray(baseline)) {
    if (actual.length !== baseline.length) {
      flags.push({
        path: fullPath,
        reason: `array length differs (actual=${actual.length}, baseline=${baseline.length})`,
        baseline: baseline.length as unknown as SnapshotValue,
        actual: actual.length as unknown as SnapshotValue,
        tolerance: null,
      });
      // Continue comparing the overlap so downstream leaf flags also surface.
      const n = Math.min(actual.length, baseline.length);
      for (let i = 0; i < n; i++) {
        walk(actual[i], baseline[i], [...path, String(i)], flags, defaultNumeric, sortedOverrides, excludeSet);
      }
      return;
    }
    for (let i = 0; i < actual.length; i++) {
      walk(actual[i], baseline[i], [...path, String(i)], flags, defaultNumeric, sortedOverrides, excludeSet);
    }
    return;
  }

  if (Array.isArray(actual) || Array.isArray(baseline)) {
    flags.push({
      path: fullPath,
      reason: `shape mismatch: array vs object`,
      baseline,
      actual,
      tolerance: null,
    });
    return;
  }

  // Both plain objects (or both tagged Maps / Sets — the tag fields just
  // become extra keys we compare like any other; if tags disagree it's a
  // shape mismatch).
  const aObj = actual as { [k: string]: SnapshotValue };
  const bObj = baseline as { [k: string]: SnapshotValue };
  const keys = new Set<string>([...Object.keys(aObj), ...Object.keys(bObj)]);
  for (const k of Array.from(keys).sort()) {
    const childPath = [...path, k];
    if (anyMatch(childPath.join("."), excludeSet)) continue;
    const aHas = k in aObj;
    const bHas = k in bObj;
    if (!aHas) {
      flags.push({
        path: childPath.join("."),
        reason: "missing in actual",
        baseline: bObj[k],
        actual: "<missing>",
        tolerance: null,
      });
      continue;
    }
    if (!bHas) {
      flags.push({
        path: childPath.join("."),
        reason: "extra in actual (not present in baseline)",
        baseline: "<missing>",
        actual: aObj[k],
        tolerance: null,
      });
      continue;
    }
    walk(aObj[k], bObj[k], childPath, flags, defaultNumeric, sortedOverrides, excludeSet);
  }
}

function compareLeaf(actual: SnapshotValue, baseline: SnapshotValue, path: string, tol: Tolerance): Flag | null {
  if (tol.kind === "exact") {
    if (deepEqual(actual, baseline)) return null;
    return {
      path,
      reason: `not equal (exact match required)`,
      baseline,
      actual,
      tolerance: tol,
    };
  }
  if (tol.kind === "categorical") {
    const s = typeof actual === "string" ? actual : JSON.stringify(actual);
    if (tol.allowed.includes(s)) return null;
    return {
      path,
      reason: `not in allowed set { ${tol.allowed.join(", ")} }`,
      baseline,
      actual,
      tolerance: tol,
    };
  }
  // Numeric
  if (typeof actual !== "number" || typeof baseline !== "number") {
    // Tolerance says numeric but the values aren't — that's a shape mismatch.
    return {
      path,
      reason: `numeric tolerance but actual=${typeof actual}, baseline=${typeof baseline}`,
      baseline,
      actual,
      tolerance: tol,
    };
  }
  const diff = Math.abs(actual - baseline);
  const absOK = tol.absolute !== undefined && diff <= tol.absolute;
  const relOK = tol.relative !== undefined && diff <= Math.abs(baseline) * tol.relative;
  if (absOK || relOK) return null;
  const reasonParts: string[] = [];
  if (tol.absolute !== undefined) reasonParts.push(`|Δ|=${diff.toPrecision(3)} > absolute ${tol.absolute}`);
  if (tol.relative !== undefined) reasonParts.push(`|Δ|/|baseline|=${(diff / Math.max(Math.abs(baseline), 1e-30)).toPrecision(3)} > relative ${tol.relative}`);
  return {
    path,
    reason: reasonParts.join(" AND "),
    baseline,
    actual,
    tolerance: tol,
  };
}

type LeafKind = "number" | "string" | "boolean" | "null" | "structural";

function leafKind(v: SnapshotValue): LeafKind {
  if (v === null) return "null";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  return "structural";
}

function pickTolerance(
  path: string,
  sortedOverrides: [string, Tolerance][],
  defaultNumeric: NumericTolerance,
  aKind: LeafKind,
  bKind: LeafKind,
): Tolerance {
  for (const [glob, tol] of sortedOverrides) {
    if (globMatches(glob, path)) return tol;
  }
  // Default per leaf kind. Numbers get the absolute default; everything else exact.
  if (aKind === "number" || bKind === "number") return defaultNumeric;
  return { kind: "exact" };
}

// ─────────────────────────────────────────────────────────────────────────
// Glob matching: `*` matches one path segment, `**` matches one OR MORE.

interface GlobMatcher {
  regex: RegExp;
  raw: string;
}

function compileGlobMatcher(glob: string): GlobMatcher {
  // Escape regex special chars except * and **, then translate * → [^.]+ and ** → .+.
  // We process ** before * to keep semantics distinct.
  const placeholder = ""; // temporary marker for **
  let pattern = glob.replace(/\*\*/g, placeholder);
  pattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  pattern = pattern.replace(/\*/g, "[^.]+");
  pattern = pattern.replace(new RegExp(placeholder, "g"), ".+");
  return { regex: new RegExp("^" + pattern + "$"), raw: glob };
}

function compileGlobMatchers(globs: string[]): GlobMatcher[] {
  return globs.map(compileGlobMatcher);
}

function globMatches(glob: string, path: string): boolean {
  return compileGlobMatcher(glob).regex.test(path);
}

function anyMatch(path: string, matchers: GlobMatcher[]): boolean {
  for (const m of matchers) if (m.regex.test(path)) return true;
  return false;
}

/** More dots and fewer wildcards → higher specificity. */
function specificityRank(glob: string): number {
  const dots = (glob.match(/\./g) ?? []).length;
  const doubleStars = (glob.match(/\*\*/g) ?? []).length;
  const singleStars = (glob.match(/(?<!\*)\*(?!\*)/g) ?? []).length;
  // depth dominates; subtract penalties for wildcards.
  return dots * 100 - doubleStars * 10 - singleStars * 1;
}

function deepEqual(a: SnapshotValue, b: SnapshotValue): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!(k in b)) return false;
      if (!deepEqual((a as Record<string, SnapshotValue>)[k], (b as Record<string, SnapshotValue>)[k])) return false;
    }
    return true;
  }
  return false;
}

/** Format flag list for human reading. Returns "" when no flags. */
export function formatFlags(flags: Flag[], samplesPerPath = 5): string {
  if (flags.length === 0) return "";
  const byPath = new Map<string, Flag[]>();
  for (const f of flags) {
    if (!byPath.has(f.path)) byPath.set(f.path, []);
    byPath.get(f.path)!.push(f);
  }
  const lines: string[] = [];
  lines.push(`${flags.length} flag(s) across ${byPath.size} path(s):`);
  for (const [p, list] of byPath) {
    lines.push(`  ${p} (${list.length}) — ${list[0].reason}`);
    for (const f of list.slice(0, samplesPerPath)) {
      lines.push(`    baseline=${formatVal(f.baseline)}  actual=${formatVal(f.actual)}`);
    }
    if (list.length > samplesPerPath) {
      lines.push(`    … and ${list.length - samplesPerPath} more`);
    }
  }
  return lines.join("\n");
}

function formatVal(v: SnapshotValue | "<missing>"): string {
  if (v === "<missing>") return "<missing>";
  if (typeof v === "number") return v.toPrecision(6);
  return JSON.stringify(v);
}

// Re-export so consumers can build path strings consistent with snapshot paths.
export { formatPath };
