/**
 * Ranged-baseline regression testing for time-series gameplay logs.
 *
 * The pattern (from the user's 2026-05-14 directive): integration tests that
 * exercise the runtime over many ticks capture per-channel samples (position,
 * velocity, FSM state, detach reasons, centripetal accel, etc.) and validate
 * them against a baseline file containing **per-channel ranges**. Only
 * out-of-range samples surface as regressions. A clean run produces no output;
 * intentional behavior improvements widen the range or update samples.
 *
 * Distinction from `baseline.ts`:
 *   - `expectBaselined` / `expectBaselinedApprox` — exact match (vitest snapshot)
 *     with optional FP rounding. Good for pure transforms.
 *   - `expectRangedBaseline` (this module) — per-frame samples validated against
 *     `[min, max]` per numeric channel, or `allowed` set per categorical channel.
 *     Right for integration tests where physics fluctuates within a known envelope.
 *
 * Baseline files live next to the test under `__baselines__/<name>.json`. They
 * are JSON-serializable, human-readable, and diff cleanly. Update them when
 * behavior intentionally changes (just like snapshots), but with the additional
 * intent of expressing tolerance: "this number should stay in [a, b]".
 *
 * No runtime / framework deps. Lives in `src/lib/testing/` alongside the
 * existing snapshot helper, runtime-agnostic per `src/lib/CLAUDE.md`.
 */

import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";

export interface NumericChannel {
  kind: "numeric";
  /** Recorded sample at each frame (optional reference — diff vs `min`/`max` is the test). */
  samples?: number[];
  /** Inclusive lower bound; samples below this are regressions. */
  min: number;
  /** Inclusive upper bound; samples above this are regressions. */
  max: number;
}

export interface CategoricalChannel {
  kind: "categorical";
  /** Recorded sample at each frame (optional reference). */
  samples?: string[];
  /** Allowed values; samples not in this set are regressions. */
  allowed: string[];
}

export type Channel = NumericChannel | CategoricalChannel;

export interface RangedBaseline {
  name: string;
  /** Number of frames recorded — captured per-channel arrays must match this length. */
  frames: number;
  /** Per-channel definitions keyed by short channel name (e.g., "pos.x", "state"). */
  channels: Record<string, Channel>;
}

export interface ChannelData {
  numeric?: number[];
  categorical?: string[];
}

export interface Regression {
  /** Channel name as keyed in the baseline. */
  channel: string;
  /** Frame index (0-based) where the regression was observed. */
  frame: number;
  /** Description of the rule that was violated. */
  rule: string;
  /** Actual value at that frame. */
  actual: number | string;
}

/**
 * Compare per-channel recorded data against the baseline. Returns the empty
 * array on a clean run; otherwise lists every out-of-range or unexpected
 * sample with frame index and channel name.
 *
 * Numeric channels: each sample must be in `[min, max]` (inclusive).
 * Categorical channels: each sample must be in `allowed`.
 * Channel length must equal `baseline.frames` — mismatched lengths are reported
 * as a single regression at frame `−1` on that channel.
 */
export function compareRangedBaseline(
  baseline: RangedBaseline,
  recorded: Record<string, number[] | string[]>,
): Regression[] {
  const out: Regression[] = [];
  for (const [name, channel] of Object.entries(baseline.channels)) {
    const got = recorded[name];
    if (got === undefined) {
      out.push({
        channel: name,
        frame: -1,
        rule: "missing channel in recorded data",
        actual: "undefined",
      });
      continue;
    }
    if (got.length !== baseline.frames) {
      out.push({
        channel: name,
        frame: -1,
        rule: `length mismatch: baseline expects ${baseline.frames} frames, got ${got.length}`,
        actual: got.length,
      });
      continue;
    }
    if (channel.kind === "numeric") {
      const nums = got as number[];
      for (let i = 0; i < nums.length; i++) {
        const v = nums[i];
        if (!Number.isFinite(v)) {
          out.push({
            channel: name,
            frame: i,
            rule: `non-finite value (${v})`,
            actual: v,
          });
        } else if (v < channel.min || v > channel.max) {
          out.push({
            channel: name,
            frame: i,
            rule: `outside [${channel.min}, ${channel.max}]`,
            actual: v,
          });
        }
      }
    } else {
      const strs = got as string[];
      const allowed = new Set(channel.allowed);
      for (let i = 0; i < strs.length; i++) {
        if (!allowed.has(strs[i])) {
          out.push({
            channel: name,
            frame: i,
            rule: `not in allowed { ${channel.allowed.join(", ")} }`,
            actual: strs[i],
          });
        }
      }
    }
  }
  return out;
}

/**
 * Format a regression list into a single multi-line string suitable for use
 * as a test failure message. Returns the empty string when there are none.
 *
 * Keeps the report tight: groups by channel, shows at most `samplesPerChannel`
 * representative frames so a wide regression doesn't drown the output.
 */
export function formatRegressions(regs: Regression[], samplesPerChannel = 5): string {
  if (regs.length === 0) return "";
  const byChannel = new Map<string, Regression[]>();
  for (const r of regs) {
    if (!byChannel.has(r.channel)) byChannel.set(r.channel, []);
    byChannel.get(r.channel)!.push(r);
  }
  const lines: string[] = [];
  lines.push(`${regs.length} regression(s) across ${byChannel.size} channel(s):`);
  for (const [channel, list] of byChannel) {
    const head = `  [${channel}] ${list.length} sample(s) failed (${list[0].rule})`;
    lines.push(head);
    const shown = list.slice(0, samplesPerChannel);
    for (const r of shown) {
      lines.push(`    frame ${r.frame}: actual=${JSON.stringify(r.actual)}`);
    }
    if (list.length > samplesPerChannel) {
      lines.push(`    … and ${list.length - samplesPerChannel} more`);
    }
  }
  return lines.join("\n");
}

/**
 * Load a baseline JSON file. Throws ENOENT if missing — callers can catch this
 * to seed an initial baseline from the current run.
 */
export async function loadRangedBaseline(path: string): Promise<RangedBaseline> {
  const abs = resolve(path);
  const text = await fs.readFile(abs, "utf-8");
  return JSON.parse(text) as RangedBaseline;
}

/**
 * Write a baseline JSON file (pretty-printed for diffability). Creates
 * parent directories if needed.
 */
export async function writeRangedBaseline(path: string, baseline: RangedBaseline): Promise<void> {
  const abs = resolve(path);
  await fs.mkdir(dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}
