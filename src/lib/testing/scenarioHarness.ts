/**
 * Scenario harness — runs a named scenario against the real WorldGenDemo runtime
 * (synthesized scene + scripted input + execution graph), captures per-channel
 * time-series, and emits the data for baseline diff / record.
 *
 * Pattern (see `wiki/worldgen-demo-generic-systems-test-harness.md`):
 *
 *  - A scenario declares: scene-builder, scripted input timeline, channels to
 *    sample, duration. The runner ticks the graph and writes a channel sample
 *    per tick.
 *  - Output is a `Record<channelName, number[] | string[]>` matched against a
 *    `RangedBaseline` via `compareRangedBaseline` (defined in `rangedBaseline.ts`).
 *  - In `--record` mode the runner derives per-channel envelopes (numeric:
 *    min/max with a tolerance pad; categorical: union of observed values) and
 *    writes a fresh `<name>.baseline.json`.
 *
 * No DOM / GL deps — this lives in `src/lib/testing/` and runs under vite-node.
 */

import type { Registry } from "../../runtime/registry";
import type { ExecutionGraph } from "../../runtime/graph";
import { executeGraph } from "../../runtime/scheduler";
import {
  type RangedBaseline,
  type Channel,
} from "./rangedBaseline";

/**
 * A scripted per-tick input. The runner walks the timeline in tick order and
 * applies the most-recent values to the active InputMap / Character input each
 * tick. Omitted fields keep their previous value (sticky).
 */
export interface ScenarioInputEvent {
  /** Tick at which this event takes effect (0-based). */
  tick: number;
  /** Move-axis values in [-1, 1]. Sticky until the next event sets them. */
  moveAxis?: { x: number; y: number };
  /** Look-delta to APPLY this tick (radians). NOT sticky — applies once, then resets. */
  lookDelta?: { yaw: number; pitch: number };
  /** Jump pressed this tick (edge). NOT sticky. */
  jumpPressed?: boolean;
}

/**
 * A single channel to sample each tick. The `sample` fn reads buffers from
 * the registry and returns either a number (numeric channel) or a string
 * (categorical channel).
 */
export interface ChannelSpec {
  name: string;
  kind: "numeric" | "categorical";
  sample: (reg: Registry, ctx: ScenarioContext) => number | string;
}

/**
 * Context handed to scene-builder + channel samplers. `entityIds` is whatever
 * the builder put there (typical: `{ player: 1 }`). `tick` is updated each
 * frame by the runner.
 */
export interface ScenarioContext {
  entityIds: Record<string, number>;
  tick: number;
}

/** Result returned by a scenario's `build` function. */
export interface ScenarioBuildResult {
  graph: ExecutionGraph;
  entityIds: Record<string, number>;
}

/**
 * A scenario is a small TS module that declares the scene + input + channels
 * to capture. Lives in `scenarios/<name>.ts`. The companion baseline lives in
 * `scenarios/__baselines__/<name>.json`.
 */
export interface ScenarioDescriptor {
  name: string;
  description: string;
  /** Seconds-per-tick fed to the scheduler. Default 1/60. */
  dt?: number;
  /** Total number of ticks to run. */
  durationTicks: number;
  /**
   * Build the registry: register buffers + systems, seed entity state, return
   * an execution graph + the entity-id table the channel samplers use.
   */
  build: (reg: Registry) => ScenarioBuildResult;
  /** Scripted input timeline, sorted ascending by tick. */
  input: ScenarioInputEvent[];
  /** Channels to capture each tick. */
  channels: ChannelSpec[];
  /**
   * Tolerance pad added to numeric channel envelopes during `--record`.
   * Example: pad=0.05 → recorded min/max widened by 5% of the observed range.
   * Defaults to 0.05.
   */
  envelopePad?: number;
}

export interface RunResult {
  /** Channel data captured tick-by-tick. Length of each array = durationTicks. */
  channels: Record<string, number[] | string[]>;
}

/**
 * Helper: apply the matching input event to the runtime buffers for this tick.
 * The scenario format is decoupled from `InputMapBuffer` / `CharacterInputBuffer`
 * — the runner translates here so scenarios stay simple.
 */
type InputApplier = (reg: Registry, event: ScenarioInputEvent | null) => void;

/**
 * Run a scenario headless. Walks the graph for `durationTicks`, applies input
 * events from the timeline, and samples each channel per tick. Returns the
 * captured channel data; caller decides whether to diff against baseline or
 * write a new baseline.
 *
 * The runner is generic — it doesn't know how to apply input. You inject an
 * `applyInput` callback that knows how to write your project's input buffers.
 */
export function runScenario(
  reg: Registry,
  scenario: ScenarioDescriptor,
  buildResult: ScenarioBuildResult,
  applyInput: InputApplier,
): RunResult {
  const dt = scenario.dt ?? 1 / 60;
  const channels: Record<string, number[] | string[]> = {};
  for (const ch of scenario.channels) {
    channels[ch.name] = ch.kind === "numeric" ? ([] as number[]) : ([] as string[]);
  }
  const ctx: ScenarioContext = { entityIds: buildResult.entityIds, tick: 0 };

  // Pre-compute tick-indexed events for sticky-value resolution.
  // Sticky values (moveAxis): carry forward until next event sets them.
  // Non-sticky values (lookDelta, jumpPressed): apply on the matching tick only.
  const eventByTick = new Map<number, ScenarioInputEvent>();
  for (const ev of scenario.input) eventByTick.set(ev.tick, ev);

  let stickyMoveAxis = { x: 0, y: 0 };

  for (let i = 0; i < scenario.durationTicks; i++) {
    ctx.tick = i;
    const event = eventByTick.get(i) ?? null;
    if (event?.moveAxis) stickyMoveAxis = event.moveAxis;
    // Build the per-tick "effective event" — combines sticky moveAxis with any
    // one-shot fields from this tick's event.
    const effective: ScenarioInputEvent = {
      tick: i,
      moveAxis: stickyMoveAxis,
      lookDelta: event?.lookDelta,
      jumpPressed: event?.jumpPressed,
    };
    applyInput(reg, effective);

    executeGraph(buildResult.graph, reg, { dt, now: i * dt * 1000 });

    for (const ch of scenario.channels) {
      const v = ch.sample(reg, ctx);
      if (ch.kind === "numeric") (channels[ch.name] as number[]).push(v as number);
      else (channels[ch.name] as string[]).push(v as string);
    }
  }
  return { channels };
}

/**
 * Build a fresh RangedBaseline from captured channel data. Numeric channels
 * get [min, max] derived from the samples, widened by `envelopePad` × range
 * on each side; categorical channels get the observed set as `allowed`.
 *
 * The pad gives the baseline some tolerance to per-run jitter (different RNG
 * seed, slightly different scheduling). Don't make it too large — too tolerant
 * a baseline catches nothing.
 */
export function deriveBaseline(
  scenario: ScenarioDescriptor,
  result: RunResult,
): RangedBaseline {
  const pad = scenario.envelopePad ?? 0.05;
  const channels: Record<string, Channel> = {};
  for (const spec of scenario.channels) {
    const data = result.channels[spec.name];
    if (!data) {
      throw new Error(`scenario ${scenario.name}: channel ${spec.name} produced no data`);
    }
    if (spec.kind === "numeric") {
      const nums = data as number[];
      let min = Infinity, max = -Infinity;
      for (const v of nums) { if (v < min) min = v; if (v > max) max = v; }
      const range = max - min;
      // Two widening rules. The proportional rule (range × pad) catches changes
      // that scale with the dynamic range of the channel. The absolute floor
      // (max(1, |peak|) × pad) keeps numerically-degenerate channels (e.g.
      // vel.x that hovers near 1e-15 from FP round-off) from generating an
      // impossibly tight envelope that future float jitter would trip.
      const peak = Math.max(Math.abs(min), Math.abs(max));
      const absoluteFloor = Math.max(1, peak) * pad;
      const widen = Math.max(range * pad, absoluteFloor);
      channels[spec.name] = {
        kind: "numeric",
        min: min - widen,
        max: max + widen,
      };
    } else {
      const strs = data as string[];
      const allowed = Array.from(new Set(strs)).sort();
      channels[spec.name] = { kind: "categorical", allowed };
    }
  }
  return {
    name: scenario.name,
    frames: scenario.durationTicks,
    channels,
  };
}
