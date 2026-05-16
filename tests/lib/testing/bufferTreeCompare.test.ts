/**
 * Unit tests for the buffer-tree comparator.
 *
 * Exercises the rules from the design doc:
 *   - Default numeric tolerance is 1e-6 absolute.
 *   - Categorical leaves require exact match unless an override widens.
 *   - Per-path tolerance overrides via glob patterns (`*` one segment, `**` any depth).
 *   - More-specific glob beats less-specific.
 *   - Exclude paths skip flagging entirely.
 *   - Structural mismatches (length, missing keys, leaf-vs-structure) all flag.
 *   - Flag output includes the full leaf path and the applied tolerance.
 */
import { describe, it, expect } from "vitest";
import {
  compareSnapshots,
  formatFlags,
  type Tolerance,
  type ToleranceOverrides,
} from "../../../src/lib/testing/bufferTreeCompare";

describe("compareSnapshots — numeric default tolerance (1e-6)", () => {
  it("no flags when |Δ| < 1e-6", () => {
    const a = { x: 1.0000001 }; // |Δ|=1e-7
    const b = { x: 1.0 };
    expect(compareSnapshots(a, b, "buf")).toEqual([]);
  });

  it("flag when |Δ| >= 1e-6", () => {
    const a = { x: 1.000005 }; // |Δ|=5e-6, well past 1e-6
    const b = { x: 1.0 };
    const flags = compareSnapshots(a, b, "buf");
    expect(flags.length).toBe(1);
    expect(flags[0].path).toBe("buf.x");
    expect(flags[0].reason).toContain("absolute 0.000001");
  });

  it("absolute tolerance can be loosened via override", () => {
    const a = { x: 1.5 };
    const b = { x: 1.0 };
    const overrides: ToleranceOverrides = {
      "buf.x": { kind: "numeric", absolute: 1.0 },
    };
    expect(compareSnapshots(a, b, "buf", { overrides })).toEqual([]);
  });
});

describe("compareSnapshots — categorical / exact", () => {
  it("flags string mismatch by default (exact match required)", () => {
    const flags = compareSnapshots({ state: "airborne" }, { state: "surfaceRun" }, "buf");
    expect(flags.length).toBe(1);
    expect(flags[0].reason).toContain("not equal (exact match required)");
  });

  it("categorical override widens allowed set", () => {
    const overrides: ToleranceOverrides = {
      "buf.state": { kind: "categorical", allowed: ["surfaceRun", "airborne", "surfaceSlide"] },
    };
    expect(compareSnapshots({ state: "airborne" }, { state: "surfaceRun" }, "buf", { overrides })).toEqual([]);
    expect(compareSnapshots({ state: "glide" }, { state: "surfaceRun" }, "buf", { overrides }).length).toBe(1);
  });
});

describe("compareSnapshots — glob overrides", () => {
  it("`*` matches a single path segment", () => {
    const a = { byEntity: { "1": { y: 1.5 }, "2": { y: 0.5 } } };
    const b = { byEntity: { "1": { y: 0 }, "2": { y: 0 } } };
    const overrides: ToleranceOverrides = {
      "buf.byEntity.*.y": { kind: "numeric", absolute: 2 },
    };
    expect(compareSnapshots(a, b, "buf", { overrides })).toEqual([]);
  });

  it("`**` matches any depth", () => {
    const a = { deep: { nest: { ed: { value: 5 } } } };
    const b = { deep: { nest: { ed: { value: 0 } } } };
    const overrides: ToleranceOverrides = {
      "**.value": { kind: "numeric", absolute: 10 },
    };
    expect(compareSnapshots(a, b, "buf", { overrides })).toEqual([]);
  });

  it("more-specific glob beats less-specific", () => {
    const a = { byEntity: { "1": { position: { "0": 5 } } } };
    const b = { byEntity: { "1": { position: { "0": 0 } } } };
    const overrides: ToleranceOverrides = {
      "**.position.0": { kind: "numeric", absolute: 10 },
      "**.position.*": { kind: "numeric", absolute: 1 },
    };
    // The "**.position.0" is more specific (more dots, fewer wildcards) → no flag.
    expect(compareSnapshots(a, b, "buf", { overrides })).toEqual([]);
  });
});

describe("compareSnapshots — structural mismatches", () => {
  it("flags missing key", () => {
    const flags = compareSnapshots({}, { x: 1 }, "buf");
    expect(flags.length).toBe(1);
    expect(flags[0].reason).toContain("missing in actual");
    expect(flags[0].path).toBe("buf.x");
  });

  it("flags extra key", () => {
    const flags = compareSnapshots({ x: 1, y: 2 }, { x: 1 }, "buf");
    expect(flags.length).toBe(1);
    expect(flags[0].reason).toContain("extra in actual");
    expect(flags[0].path).toBe("buf.y");
  });

  it("flags array length difference and still compares overlap", () => {
    const flags = compareSnapshots(
      { arr: [1, 2, 3, 4] },
      { arr: [1, 2, 3] },
      "buf",
    );
    // 1 length flag; the overlap (indices 0,1,2) match so no leaf flags.
    expect(flags.length).toBe(1);
    expect(flags[0].reason).toContain("array length differs");
  });

  it("flags leaf-vs-structure shape mismatch", () => {
    const flags = compareSnapshots({ x: 1 }, { x: { nested: 1 } }, "buf");
    expect(flags.length).toBe(1);
    expect(flags[0].reason).toContain("shape mismatch");
  });
});

describe("compareSnapshots — excludePaths", () => {
  it("skips paths matching the excludePaths globs", () => {
    const a = { transitions: [{ from: "a", to: "b", t: 100 }] };
    const b = { transitions: [{ from: "a", to: "b", t: 200 }] };
    expect(compareSnapshots(a, b, "buf", { excludePaths: ["buf.transitions.*.t"] })).toEqual([]);
  });

  it("** excludes everything under a path", () => {
    const a = { stages: { parse: 1, jfa: 2 }, warnings: ["w1"] };
    const b = { stages: { parse: 5, jfa: 9 }, warnings: ["w1"] };
    expect(compareSnapshots(a, b, "buf", { excludePaths: ["buf.stages.**"] })).toEqual([]);
  });
});

describe("compareSnapshots — Set / Map encoded shapes", () => {
  it("treats tagged Map objects as plain objects (recurses into entries)", () => {
    const a = { __map__: true, "1": { v: 1.0 }, "2": { v: 2.0 } };
    const b = { __map__: true, "1": { v: 1.0 }, "2": { v: 99.0 } };
    const flags = compareSnapshots(a, b, "buf");
    expect(flags.length).toBe(1);
    expect(flags[0].path).toBe("buf.2.v");
  });

  it("treats tagged Set objects (sorted values) via array comparison", () => {
    const a = { __set__: true, values: ["a", "c"] };
    const b = { __set__: true, values: ["a", "b"] };
    const flags = compareSnapshots(a, b, "buf");
    // values[1] differs ("c" vs "b") AND tag fields match.
    expect(flags.some((f) => f.path === "buf.values.1")).toBe(true);
  });
});

describe("formatFlags — human-readable output", () => {
  it("returns empty string when there are no flags", () => {
    expect(formatFlags([])).toBe("");
  });

  it("groups by path and shows headline + samples", () => {
    const flags = [
      { path: "buf.x", reason: "outside 1e-6", baseline: 0, actual: 5, tolerance: { kind: "numeric", absolute: 1e-6 } as Tolerance },
      { path: "buf.y", reason: "outside 1e-6", baseline: 0, actual: 5, tolerance: { kind: "numeric", absolute: 1e-6 } as Tolerance },
    ];
    const out = formatFlags(flags);
    expect(out).toContain("2 flag(s)");
    expect(out).toContain("buf.x");
    expect(out).toContain("buf.y");
  });
});
