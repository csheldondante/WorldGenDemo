/**
 * Buffer-snapshot test runner.
 *
 * A `BufferTest` describes a pure data transformation:
 *   - Apply some input (a `seed(reg)` callback or a recorded `snapshot`) to
 *     the runtime buffers.
 *   - Run a configured sequence of execution steps (an ad-hoc graph from a
 *     system-id list, OR the SM's currently-active graph).
 *   - Snapshot the configured output buffers.
 *   - Compare to a baseline tree with per-leaf tolerances, return flags.
 *
 * Uses the REAL runtime via `bootstrapApp` — no parallel test architecture.
 * The only knobs are which input system feeds `INPUT_SYSTEM_ID` (playback /
 * simulated / virtual) and which systems run in each step.
 *
 * Lives in `src/app/` because it composes runtime + bootstrap concerns;
 * `src/lib/` cannot import the runtime per layer rules.
 */

import { readBuffer, writeBuffer, type BufferId } from "../runtime/buffer";
import type { Registry } from "../runtime/registry";
import type { SystemDescriptor, SystemId } from "../runtime/system";
import { executeGraph } from "../runtime/scheduler";
import { buildExecutionGraph } from "../runtime/graph";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../runtime/stateMachine";
import { bootstrapApp } from "./bootstrap";
import {
  snapshotBufferData,
  restoreBufferData,
  type SerializedBuffer,
  type SnapshotValue,
} from "../lib/testing/bufferSnapshot";
import {
  compareSnapshots,
  type Flag,
  type ToleranceOverrides,
} from "../lib/testing/bufferTreeCompare";

/** Baseline file shape — what gets written to `__baselines__/<name>.json`. */
export interface BaselineFile {
  name: string;
  /** Captured buffer values keyed by buffer id. */
  buffers: Record<BufferId, SnapshotValue>;
  /**
   * Per-path tolerance overrides. Paths are dotted leaf paths prefixed with
   * the buffer id (e.g. `"transform.byEntity.1.position.2"`). Glob: `*` = one
   * segment, `**` = any depth. Stored INLINE in the same JSON file so authors
   * see captured values + tolerances side by side.
   */
  toleranceOverrides: ToleranceOverrides;
  /**
   * Paths to skip entirely (e.g. timestamp leaves the runner can't make
   * deterministic). Same glob semantics. Default empty.
   */
  excludePaths?: string[];
}

/** What the test ran against — a `seed` callback or a recorded snapshot. */
export type TestInput =
  | { kind: "seed"; fn: (reg: Registry) => void }
  | { kind: "snapshot"; buffers: Record<BufferId, SerializedBuffer> };

/** One execution step. `tickSystems` builds a one-off graph from a hand-picked
 *  system list; `tickActiveGraph` runs whichever graph the SM currently has
 *  selected (identical to `startLoop`). */
export type TestStep =
  | { kind: "tickSystems"; systemIds: SystemId[]; ticks: number; dt?: number }
  | { kind: "tickActiveGraph"; ticks: number; dt?: number };

export interface BufferTest {
  name: string;
  description: string;
  input: TestInput;
  /** Drop-in for INPUT_SYSTEM_ID. If omitted, the real DOM-listener input
   *  system is registered (rare in tests; usually overridden). */
  inputSystem?: SystemDescriptor;
  steps: TestStep[];
  output: {
    snapshot: BufferId[];
    baseline?: BaselineFile;
  };
}

export interface TestResult {
  /** Per-buffer snapshot of the output, keyed by buffer id. */
  captured: Record<BufferId, SnapshotValue>;
  /** Empty when the test passed. */
  flags: Flag[];
  /** Final SM state for the runner's summary line. */
  finalSmState: string;
  /** Total ticks executed across all steps. */
  totalTicks: number;
}

export interface RunBufferTestOptions {
  /** When true, skip the comparator entirely — caller wants to record a
   *  fresh baseline from the captured output. Default false. */
  recordOnly?: boolean;
}

/**
 * Headless test runner. Pure(-ish) — touches no DOM, no Three.js. Builds the
 * full real runtime (every core system registered, every real graph validated)
 * and ticks it according to `test.steps`.
 *
 * Determinism: the runner passes `now = i * dt * 1000` (milliseconds) to the
 * scheduler so any `performance.now()`-style timestamps inside the loop are
 * derived from the deterministic tick index, not wall-clock.
 */
export function runBufferTest(test: BufferTest, options: RunBufferTestOptions = {}): TestResult {
  const app = bootstrapApp({ inputSystem: test.inputSystem, sceneName: null });
  const reg = app.registry;

  applyInput(reg, test.input);

  let cumulativeTicks = 0;
  for (let stepIdx = 0; stepIdx < test.steps.length; stepIdx++) {
    const step = test.steps[stepIdx];
    cumulativeTicks = executeStep(reg, step, stepIdx, cumulativeTicks);
  }

  // Capture
  const captured: Record<BufferId, SnapshotValue> = {};
  for (const bufId of test.output.snapshot) {
    if (!reg.hasBuffer(bufId)) {
      throw new Error(`bufferTest "${test.name}": output snapshot includes unregistered buffer "${bufId}"`);
    }
    const buf = reg.getBuffer(bufId);
    captured[bufId] = snapshotBufferData(buf.data);
  }

  // Compare (unless caller is in record-only mode).
  const flags: Flag[] = [];
  if (!options.recordOnly && test.output.baseline) {
    for (const bufId of test.output.snapshot) {
      const actual = captured[bufId];
      const baseline = test.output.baseline.buffers[bufId];
      if (baseline === undefined) {
        flags.push({
          path: bufId,
          reason: "buffer in snapshot list missing from baseline file",
          baseline: "<missing>",
          actual,
          tolerance: null,
        });
        continue;
      }
      const bufFlags = compareSnapshots(actual, baseline, bufId, {
        overrides: test.output.baseline.toleranceOverrides,
        excludePaths: test.output.baseline.excludePaths,
      });
      flags.push(...bufFlags);
    }
  }

  const sm = readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
  return { captured, flags, finalSmState: sm.state, totalTicks: cumulativeTicks };
}

/** Build a `BaselineFile` from a captured snapshot — empty tolerance overrides;
 *  the human edits them in post-hoc with justification. */
export function deriveBaselineFromCapture(
  testName: string,
  captured: Record<BufferId, SnapshotValue>,
): BaselineFile {
  return {
    name: testName,
    buffers: { ...captured },
    toleranceOverrides: {},
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Internals

function applyInput(reg: Registry, input: TestInput): void {
  if (input.kind === "seed") {
    input.fn(reg);
    return;
  }
  for (const [bufId, serialized] of Object.entries(input.buffers)) {
    if (!reg.hasBuffer(bufId)) {
      throw new Error(`bufferTest input: serialized buffer "${bufId}" is not registered in the runtime`);
    }
    const buf = reg.getBuffer(bufId);
    const restored = restoreBufferData(serialized.data);
    writeBuffer(buf, (_d) => restored as never);
  }
}

function executeStep(
  reg: Registry,
  step: TestStep,
  stepIdx: number,
  startingTick: number,
): number {
  const dt = step.dt ?? 1 / 60;
  let tick = startingTick;
  if (step.kind === "tickActiveGraph") {
    for (let i = 0; i < step.ticks; i++) {
      const sm = readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      const graph = reg.getGraph(sm.activeGraph);
      executeGraph(graph, reg, { dt, now: tick * dt * 1000 });
      tick += 1;
    }
    return tick;
  }
  // tickSystems
  const graph = buildExecutionGraph({
    id: `bufferTest-step-${stepIdx}`,
    nodes: step.systemIds,
    registry: reg,
  });
  for (let i = 0; i < step.ticks; i++) {
    executeGraph(graph, reg, { dt, now: tick * dt * 1000 });
    tick += 1;
  }
  return tick;
}
