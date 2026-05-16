/**
 * Scenario harness — runs a named scenario against the REAL WorldGenDemo
 * runtime (`bootstrapApp` from `src/app/bootstrap.ts`). Scenarios are pure
 * data + a `seed` callback that initializes scene state; everything else
 * (systems, graphs, scheduler, FSM) is the production architecture.
 *
 * What "uses the real architecture" means concretely:
 *   - `bootstrapApp({ inputSystem })` registers every core buffer and system
 *     and builds the real Loading/Running/Rebuilding/Builder graphs. The only
 *     swap is the input source (real DOM → playback recording or simulated
 *     generator).
 *   - The runner ticks `executeGraph(reg.getGraph(sm.activeGraph), reg, ...)`
 *     each frame, identical to `startLoop`. The graph that runs is whichever
 *     graph the state machine has chosen — same dispatch the real game uses.
 *   - Scenarios `seed(reg)` can either (a) force the SM into a target state +
 *     write synthetic buffers (headless gym tests) or (b) emit a real
 *     `LoadRequested` event and let the bitmap pipeline produce the scene
 *     (browser play mode).
 *
 * Channel capture runs after each tick. Diff or record uses
 * `rangedBaseline.ts` (numeric envelopes + categorical sets).
 */

import type { Registry } from "../../runtime/registry";
import { readBuffer } from "../../runtime/buffer";
import { executeGraph } from "../../runtime/scheduler";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../runtime/stateMachine";
import {
  type RangedBaseline,
  type Channel,
} from "./rangedBaseline";

/**
 * Forward-declared input source shape. The concrete types `InputRecording`
 * and `SimulatedInputGenerator` live in `src/systems/testing/*` (which
 * `src/lib/` cannot import per layer rules). The scenario-runner script
 * (which lives outside `src/lib/`) is responsible for converting these
 * sources into a SystemDescriptor before calling `bootstrapApp`.
 *
 * Keeping the type "opaque" here means scenario files declared in
 * `scenarios/<name>.ts` can reference `ScenarioInputSource` without
 * dragging system internals into the lib layer.
 */
export type ScenarioInputSource =
  | { kind: "playback"; recording: unknown }     // InputRecording at the runner layer
  | { kind: "simulated"; generator: unknown };   // SimulatedInputGenerator at the runner layer

/** A scenario seeds the runtime and declares what to capture. */
export interface ScenarioDescriptor {
  name: string;
  description: string;
  /** Seconds-per-tick fed to the scheduler. Default 1/60. */
  dt?: number;
  /** Number of ticks to run AFTER the runtime is in the target state (typically Running). */
  durationTicks: number;
  /**
   * Where InputBuffer gets its values from. The scenario runner translates
   * this into a SystemDescriptor with id = INPUT_SYSTEM_ID and feeds it to
   * `bootstrapApp` so the real input pipeline (mapper → characterInput) sees
   * a normal-looking InputBuffer.
   */
  inputSource: ScenarioInputSource;
  /**
   * Seed the registry. Called once, immediately after `bootstrapApp` returns.
   * Typical responsibilities:
   *   - Force StateMachineBuffer.state = "Running" + activeGraph = "Running"
   *     for headless gym tests (no scene-load pipeline).
   *   - Or emit a LoadRequested event for browser play mode (real scene boot).
   *   - Write the SurfaceProviderBuffer with a synthetic provider.
   *   - Spawn the player entity (Transform, Velocity, CharacterController,
   *     SurfaceAttachment, etc.).
   *
   * Returns an `entityIds` table so channel samplers can refer to the player
   * by a stable name.
   */
  seed: (reg: Registry) => { entityIds: Record<string, number> };
  channels: ChannelSpec[];
  /** Envelope-widening pad used by `--record`. Defaults to 0.05 (5%). */
  envelopePad?: number;
}

export interface ChannelSpec {
  name: string;
  kind: "numeric" | "categorical";
  sample: (reg: Registry, ctx: ScenarioContext) => number | string;
}

export interface ScenarioContext {
  entityIds: Record<string, number>;
  tick: number;
  activeGraph: string;
}

export interface RunResult {
  channels: Record<string, number[] | string[]>;
  /** Final state-machine snapshot for diagnostics. */
  finalSmState: string;
}

/**
 * Headless scenario runner. Caller has already called `bootstrapApp` with the
 * scenario's `inputSource` translated into a SystemDescriptor — the seed
 * callback has run and the player entity exists in the registry.
 *
 * Each tick:
 *   1. Read `StateMachineBuffer.activeGraph` (the real dispatcher does this).
 *   2. `executeGraph(graph, reg, { dt, now })`.
 *   3. Sample channels.
 */
export function runScenarioHeadless(
  reg: Registry,
  scenario: ScenarioDescriptor,
  entityIds: Record<string, number>,
): RunResult {
  const dt = scenario.dt ?? 1 / 60;
  const channels: Record<string, number[] | string[]> = {};
  for (const ch of scenario.channels) {
    channels[ch.name] = ch.kind === "numeric" ? ([] as number[]) : ([] as string[]);
  }
  const ctx: ScenarioContext = { entityIds, tick: 0, activeGraph: "" };

  for (let i = 0; i < scenario.durationTicks; i++) {
    const sm = readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
    ctx.activeGraph = sm.activeGraph;
    ctx.tick = i;
    const graph = reg.getGraph(sm.activeGraph);
    executeGraph(graph, reg, { dt, now: i * dt * 1000 });
    for (const ch of scenario.channels) {
      const v = ch.sample(reg, ctx);
      if (ch.kind === "numeric") (channels[ch.name] as number[]).push(v as number);
      else (channels[ch.name] as string[]).push(v as string);
    }
  }
  const finalSm = readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
  return { channels, finalSmState: finalSm.state };
}

/**
 * Build a `RangedBaseline` from captured channel data. Numeric channels get
 * [min, max] derived from the samples, widened by `envelopePad`; categorical
 * channels get the observed set as `allowed`.
 *
 * Widening uses two rules together — proportional × pad (catches changes that
 * scale with the channel's dynamic range) and an absolute floor (keeps
 * numerically-degenerate channels like vel.x ≈ 1e-15 from producing baselines
 * future FP jitter immediately trips).
 */
export function deriveBaseline(
  scenario: ScenarioDescriptor,
  result: RunResult,
): RangedBaseline {
  const pad = scenario.envelopePad ?? 0.05;
  const channels: Record<string, Channel> = {};
  for (const spec of scenario.channels) {
    const data = result.channels[spec.name];
    if (!data) throw new Error(`scenario ${scenario.name}: channel ${spec.name} produced no data`);
    if (spec.kind === "numeric") {
      const nums = data as number[];
      let min = Infinity, max = -Infinity;
      for (const v of nums) { if (v < min) min = v; if (v > max) max = v; }
      const range = max - min;
      const peak = Math.max(Math.abs(min), Math.abs(max));
      const absoluteFloor = Math.max(1, peak) * pad;
      const widen = Math.max(range * pad, absoluteFloor);
      channels[spec.name] = { kind: "numeric", min: min - widen, max: max + widen };
    } else {
      const strs = data as string[];
      channels[spec.name] = { kind: "categorical", allowed: Array.from(new Set(strs)).sort() };
    }
  }
  return { name: scenario.name, frames: scenario.durationTicks, channels };
}
