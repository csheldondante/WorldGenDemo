import { describe, it, expect } from "vitest";
import {
  compareRangedBaseline,
  formatRegressions,
  type RangedBaseline,
} from "../../../src/lib/testing/rangedBaseline";

describe("compareRangedBaseline", () => {
  it("returns no regressions when all numeric samples are in range and categoricals in allowed", () => {
    const baseline: RangedBaseline = {
      name: "clean",
      frames: 3,
      channels: {
        "pos.x": { kind: "numeric", min: 0, max: 10 },
        state: { kind: "categorical", allowed: ["surfaceRun", "airborne"] },
      },
    };
    const regs = compareRangedBaseline(baseline, {
      "pos.x": [1, 5, 9.99],
      state: ["surfaceRun", "surfaceRun", "airborne"],
    });
    expect(regs).toEqual([]);
  });

  it("flags numeric samples outside [min, max]", () => {
    const baseline: RangedBaseline = {
      name: "range-fail",
      frames: 4,
      channels: { v: { kind: "numeric", min: -1, max: 1 } },
    };
    const regs = compareRangedBaseline(baseline, { v: [0.5, 2, -1.5, 0] });
    expect(regs.length).toBe(2);
    expect(regs[0]).toMatchObject({ channel: "v", frame: 1, actual: 2 });
    expect(regs[1]).toMatchObject({ channel: "v", frame: 2, actual: -1.5 });
  });

  it("flags categorical samples not in allowed", () => {
    const baseline: RangedBaseline = {
      name: "cat-fail",
      frames: 3,
      channels: { st: { kind: "categorical", allowed: ["a", "b"] } },
    };
    const regs = compareRangedBaseline(baseline, { st: ["a", "c", "b"] });
    expect(regs.length).toBe(1);
    expect(regs[0]).toMatchObject({ channel: "st", frame: 1, actual: "c" });
  });

  it("flags non-finite values as regressions", () => {
    const baseline: RangedBaseline = {
      name: "nan",
      frames: 2,
      channels: { v: { kind: "numeric", min: -10, max: 10 } },
    };
    const regs = compareRangedBaseline(baseline, { v: [NaN, Infinity] });
    expect(regs.length).toBe(2);
    expect(regs[0].rule).toContain("non-finite");
  });

  it("reports missing channels in recorded data", () => {
    const baseline: RangedBaseline = {
      name: "missing",
      frames: 2,
      channels: { a: { kind: "numeric", min: 0, max: 1 } },
    };
    const regs = compareRangedBaseline(baseline, {});
    expect(regs.length).toBe(1);
    expect(regs[0]).toMatchObject({ channel: "a", frame: -1 });
    expect(regs[0].rule).toContain("missing");
  });

  it("reports length mismatches with one entry at frame -1", () => {
    const baseline: RangedBaseline = {
      name: "len",
      frames: 3,
      channels: { a: { kind: "numeric", min: 0, max: 1 } },
    };
    const regs = compareRangedBaseline(baseline, { a: [0.5, 0.5] });
    expect(regs.length).toBe(1);
    expect(regs[0]).toMatchObject({ channel: "a", frame: -1 });
    expect(regs[0].rule).toContain("length mismatch");
  });

  it("includes inclusive boundaries (samples exactly at min or max pass)", () => {
    const baseline: RangedBaseline = {
      name: "boundary",
      frames: 2,
      channels: { v: { kind: "numeric", min: 0, max: 1 } },
    };
    expect(compareRangedBaseline(baseline, { v: [0, 1] })).toEqual([]);
  });
});

describe("formatRegressions", () => {
  it("returns the empty string on a clean run", () => {
    expect(formatRegressions([])).toBe("");
  });

  it("groups by channel and limits per-channel samples shown", () => {
    const regs = [
      { channel: "v", frame: 0, rule: "outside [0, 1]", actual: 2 },
      { channel: "v", frame: 1, rule: "outside [0, 1]", actual: 3 },
      { channel: "v", frame: 2, rule: "outside [0, 1]", actual: 4 },
      { channel: "v", frame: 3, rule: "outside [0, 1]", actual: 5 },
      { channel: "v", frame: 4, rule: "outside [0, 1]", actual: 6 },
      { channel: "v", frame: 5, rule: "outside [0, 1]", actual: 7 },
      { channel: "v", frame: 6, rule: "outside [0, 1]", actual: 8 },
      { channel: "st", frame: 0, rule: "not in allowed { a, b }", actual: "c" },
    ];
    const out = formatRegressions(regs, 3);
    expect(out).toContain("8 regression(s)");
    expect(out).toContain("[v] 7 sample(s) failed");
    expect(out).toContain("[st] 1 sample(s) failed");
    expect(out).toContain("… and 4 more");
  });
});
