/**
 * Phase 3b — transitions activation. Verifies the runtime mechanism:
 *
 *   - When TransitionStateBuffer.activeTransitionId is set, the loop
 *     runs the transition's systems instead of the active mode's.
 *   - When the transition's isComplete returns true, the loop clears
 *     the buffer and advances activeMode to the transition's `to`.
 *
 * Tested with a synthetic mini-runtime — a counter buffer + a single
 * "increment" system as the transition's body + a "counter === 3"
 * isComplete rule. Avoids coupling to the real Rebuilding pipeline
 * which has many dependencies; the same mechanism applies there.
 */

import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";
import type { SystemDescriptor } from "../../src/runtime/system";
import { createStateMachineBuffer } from "../../src/buffers/stateMachine";
import {
  createTransitionStateBuffer,
  TRANSITION_STATE_BUFFER_ID,
  type TransitionStateBufferData,
} from "../../src/buffers/transitionState";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../src/runtime/stateMachine";

const COUNTER_BUFFER_ID = "counter";
const INCREMENT_SYSTEM_ID = "incrementSystem";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createStateMachineBuffer());
  reg.registerBuffer(createTransitionStateBuffer());
  reg.registerBuffer(createBuffer<{ value: number }>({
    id: COUNTER_BUFFER_ID,
    description: "test counter",
    initial: { value: 0 },
  }));
  // The transition's only system: increment counter.
  const inc: SystemDescriptor = {
    id: INCREMENT_SYSTEM_ID,
    description: "increment counter",
    buffers: [{ id: COUNTER_BUFFER_ID, access: "readwrite" }],
    execute: ({ buffer }) => {
      writeBuffer(buffer<{ value: number }>(COUNTER_BUFFER_ID), (d) => { d.value += 1; });
    },
  };
  reg.registerSystem(inc);
  // No mode systems registered — the loop uses transitions only.
  // But getOrBuildGraphForMode needs SOMETHING when no transition is
  // active; we'll register a no-op "Idle" mode for the post-transition
  // ticks.
  const noop: SystemDescriptor = {
    id: "noopSystem",
    description: "no-op for idle ticks",
    buffers: [],
    execute: () => { /* nothing */ },
  };
  reg.registerSystem(noop);
  reg.registerMode({
    id: "Idle",
    label: "Idle",
    tags: ["core"],
    systems: ["noopSystem"],
  });
  reg.registerMode({
    id: "Done",
    label: "Done",
    tags: ["core"],
    systems: ["noopSystem"],
  });
  // Register the transition: runs INCREMENT_SYSTEM_ID; complete when
  // counter.value reaches 3.
  reg.registerTransition({
    id: "IdleToDone",
    from: "Idle",
    to: "Done",
    systems: [INCREMENT_SYSTEM_ID],
    isComplete: (r) => {
      const buf = r.getBuffer<{ value: number }>(COUNTER_BUFFER_ID);
      return readBuffer(buf).value >= 3;
    },
  });
  // Seed SM in Idle and activate the transition.
  writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
    d.activeMode = "Idle";
    d.state = "Running"; // arbitrary, not used by this test
    d.activeGraph = "Idle";
  });
  writeBuffer(reg.getBuffer<TransitionStateBufferData>(TRANSITION_STATE_BUFFER_ID), (d) => {
    d.activeTransitionId = "IdleToDone";
    d.startedTick = 0;
  });
  return reg;
}

// Drive the loop synchronously by calling the same tick logic the
// rAF would call. We use the real startLoop but stop it immediately
// — then we replicate its inner step manually via direct calls. Since
// the loop is rAF-driven and tests don't have a frame loop, we instead
// invoke graph execution directly via the helper exposed by the
// runtime. For this test, we just call executeGraph in a loop.
import { executeGraph } from "../../src/runtime/scheduler";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { getOrBuildGraphForMode } from "../../src/runtime/mode";

function manualTick(reg: ReturnType<typeof setup>): void {
  // Mirrors the relevant logic from startLoop, headless-friendly.
  const smBuf = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
  const tsBuf = reg.getBuffer<TransitionStateBufferData>(TRANSITION_STATE_BUFFER_ID);
  const activeTransitionId = readBuffer(tsBuf).activeTransitionId;
  let graph;
  if (activeTransitionId !== null) {
    const t = reg.getTransition(activeTransitionId)!;
    graph = buildExecutionGraph({ id: `t:${activeTransitionId}`, nodes: t.systems, registry: reg });
  } else {
    graph = getOrBuildGraphForMode(reg, readBuffer(smBuf).activeMode);
  }
  executeGraph(graph, reg, { dt: 1 / 60, now: 0 });
  if (activeTransitionId !== null) {
    const t = reg.getTransition(activeTransitionId)!;
    if (t.isComplete(reg)) {
      writeBuffer(tsBuf, (d) => { d.activeTransitionId = null; d.startedTick = 0; });
      writeBuffer(smBuf, (d) => { d.activeMode = t.to; });
    }
  }
}

describe("Phase 3b — transitions activation", () => {
  it("loop runs the transition's systems while activeTransitionId is set", () => {
    const reg = setup();
    manualTick(reg);
    expect(readBuffer(reg.getBuffer<{ value: number }>(COUNTER_BUFFER_ID)).value).toBe(1);
  });

  it("transition runs until isComplete then clears activeTransitionId + advances activeMode", () => {
    const reg = setup();
    manualTick(reg); // value=1
    manualTick(reg); // value=2
    manualTick(reg); // value=3, isComplete=true, advance to Done
    const ts = readBuffer(reg.getBuffer<TransitionStateBufferData>(TRANSITION_STATE_BUFFER_ID));
    const sm = readBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
    expect(ts.activeTransitionId).toBeNull();
    expect(sm.activeMode).toBe("Done");
  });

  it("after transition completes, subsequent ticks run the destination mode's systems (= no-op here)", () => {
    const reg = setup();
    manualTick(reg);
    manualTick(reg);
    manualTick(reg); // complete; activeMode → Done
    manualTick(reg); // runs Done mode's noop system; counter unchanged
    manualTick(reg);
    expect(readBuffer(reg.getBuffer<{ value: number }>(COUNTER_BUFFER_ID)).value).toBe(3);
  });

  // startLoop integration covered by smoke harness (= browser
  // playback in npm run smoke). The rAF-driven loop isn't directly
  // testable in node without polyfills; the synchronous behavior is
  // covered by manualTick above.
});
