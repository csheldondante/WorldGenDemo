/**
 * InputSourceSelectorSystem — observes activeMode and applies the
 * matching input source + recording flag. Tests the data-driven
 * trigger pattern without requiring DOM / button handlers.
 */

import { describe, it, expect, vi } from "vitest";
import { createRegistry, type Registry } from "../../src/runtime/registry";
import { writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../../src/runtime/stateMachine";
import { createStateMachineBuffer } from "../../src/buffers/stateMachine";
import { createEventBuffer } from "../../src/buffers/event";
import type { SystemDescriptor } from "../../src/runtime/system";
import {
  createInputSourceSelectorSystem,
  INPUT_SOURCE_SELECTOR_SYSTEM_ID,
} from "../../src/systems/inputSourceSelector";
import {
  createInputRecordingState,
  type InputRecordingState,
} from "../../src/systems/testing/inputRecording";

const SHARED_INPUT_ID = "inputSystem";

function fakeInput(label: string): SystemDescriptor {
  return {
    id: SHARED_INPUT_ID,
    description: `fake input system: ${label}`,
    buffers: [],
    execute: () => { /* no-op for tests */ },
  };
}

function setup(): {
  reg: Registry;
  recording: InputRecordingState;
  scripted: SystemDescriptor;
  live: SystemDescriptor;
  setMode: (mode: string) => void;
  tick: () => void;
  onRecordingComplete: ReturnType<typeof vi.fn>;
} {
  const reg = createRegistry();
  reg.registerBuffer(createStateMachineBuffer());
  reg.registerBuffer(createEventBuffer());
  const scripted = fakeInput("scripted");
  const live = fakeInput("live");
  // Register ONE input system descriptor initially — scripted (=
  // matches the scenario-boot convention).
  reg.registerSystem(scripted);
  const recording = createInputRecordingState();
  const onRecordingComplete = vi.fn();
  reg.registerSystem(
    createInputSourceSelectorSystem(reg, {
      modes: {
        ScenarioPlayback: { input: scripted },
        ScenarioFreePlay: { input: live },
        ScenarioRecording: { input: live, recording: true },
      },
      recordingState: recording,
      onRecordingComplete,
    }),
  );
  const graph = buildExecutionGraph({
    id: "test",
    nodes: [INPUT_SOURCE_SELECTOR_SYSTEM_ID],
    registry: reg,
  });
  const setMode = (mode: string) => {
    writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
      d.activeMode = mode;
    });
  };
  const tick = () => {
    executeGraph(graph, reg, { dt: 1 / 60, now: 0 });
  };
  return { reg, recording, scripted, live, setMode, tick, onRecordingComplete };
}

describe("InputSourceSelectorSystem — Phase 5b-style activeMode reactor", () => {
  it("activeMode change to ScenarioFreePlay swaps input descriptor to the live system", () => {
    const { reg, setMode, tick, live } = setup();
    setMode("ScenarioFreePlay");
    tick();
    expect(reg.getSystem(SHARED_INPUT_ID).description).toBe(live.description);
  });

  it("activeMode change to ScenarioRecording sets recording.active=true + resets log", () => {
    const { recording, setMode, tick } = setup();
    // Seed a stale recording so we can verify reset.
    recording.cursor = 42;
    recording.recording = { frames: 42, events: [{ tick: 0, keys: ["KeyW"] }] };
    setMode("ScenarioRecording");
    tick();
    expect(recording.active).toBe(true);
    expect(recording.cursor).toBe(0);
    expect(recording.recording.frames).toBe(0);
    expect(recording.recording.events).toEqual([]);
  });

  it("activeMode change away from a recording mode fires onRecordingComplete and clears active flag", () => {
    const { recording, setMode, tick, onRecordingComplete } = setup();
    setMode("ScenarioRecording");
    tick();
    expect(recording.active).toBe(true);
    setMode("ScenarioPlayback");
    tick();
    expect(recording.active).toBe(false);
    expect(onRecordingComplete).toHaveBeenCalledOnce();
    expect(onRecordingComplete).toHaveBeenCalledWith(recording);
  });

  it("activeMode change to an unmanaged mode (e.g. LibraryViewer) does NOT swap input", () => {
    const { reg, setMode, tick } = setup();
    // Initial mode swap to ScenarioFreePlay (= managed mode).
    setMode("ScenarioFreePlay");
    tick();
    // Now switch to LibraryViewer (= not in the input-source map).
    setMode("LibraryViewer");
    tick();
    // Input descriptor stays as whatever was last installed (= live).
    // Critically, the selector did NOT throw or reset.
    expect(reg.getSystem(SHARED_INPUT_ID).description).toContain("live");
  });

  it("activeMode change to unmanaged mode while recording cleanly flushes recording", () => {
    const { recording, setMode, tick, onRecordingComplete } = setup();
    setMode("ScenarioRecording");
    tick();
    expect(recording.active).toBe(true);
    setMode("LibraryViewer"); // unmanaged
    tick();
    expect(recording.active).toBe(false);
    expect(onRecordingComplete).toHaveBeenCalledOnce();
  });

  it("idempotent: same activeMode across two ticks → no re-swap", () => {
    const { reg, setMode, tick } = setup();
    setMode("ScenarioFreePlay");
    tick();
    // Swap the descriptor under the hood to verify the selector does NOT
    // re-apply on a no-op tick (= it'd clobber any external change).
    const sentinel: SystemDescriptor = {
      id: SHARED_INPUT_ID,
      description: "sentinel-do-not-overwrite",
      buffers: [],
      execute: () => { /* no-op */ },
    };
    reg.replaceSystem(sentinel);
    tick(); // activeMode unchanged → selector should be a no-op
    expect(reg.getSystem(SHARED_INPUT_ID).description).toBe("sentinel-do-not-overwrite");
  });
});
