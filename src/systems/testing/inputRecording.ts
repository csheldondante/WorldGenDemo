/**
 * Live input recording system. Runs AFTER the real `inputSystem` (or any
 * `INPUT_SYSTEM_ID` provider) and snapshots `InputBuffer` per tick into an
 * in-memory `InputRecording`.
 *
 * The recording is **sparse**: each tick the system diffs against the
 * previous frame and emits a frame entry only when something CHANGED (or
 * for mouseDx/Dy any non-zero deltas, which are always one-shot). Keeps
 * recordings compact even for long sessions.
 *
 * State (cursor + prev-frame snapshot + the recording itself) lives on
 * an externalized `InputRecordingState` object so the UI can `reset()`
 * a recording session without re-registering the system in the graph.
 * `active` gates whether the system writes anything; when false, the
 * system still ticks but performs no work — cheap to keep registered
 * in the Running graph in scenario mode without affecting normal play.
 *
 * Recorded format matches `InputRecording` consumed by `inputPlaybackSystem`,
 * so record-then-play round-trips cleanly.
 */
import type { SystemDescriptor } from "../../runtime/system";
import { readBuffer } from "../../runtime/buffer";
import { INPUT_BUFFER_ID, type InputBufferData } from "../../buffers/input";
import { INPUT_SYSTEM_ID } from "../input";
import { INPUT_MAPPER_SYSTEM_ID } from "../inputMapper";
import type { InputFrame, InputRecording } from "./inputPlayback";

export const INPUT_RECORDING_SYSTEM_ID = "inputRecordingSystem";

export interface InputRecordingState {
  /** Whether the system actively writes frames this tick. Toggled by the UI. */
  active: boolean;
  /** Maximum frames to record before auto-stopping. 0 = no cap. */
  frameCap: number;
  /** The accumulated recording. Replaced when a new session starts. */
  recording: InputRecording;
  // Internal diff state — public for `resetInputRecording`.
  cursor: number;
  prevKeys: Set<string>;
  prevButtons: Set<string>;
  prevPointerLocked: boolean;
  prevGamepadConnected: boolean;
  prevAxes: { leftX: number; leftY: number; rightX: number; rightY: number };
}

export function createInputRecordingState(frameCap = 1800): InputRecordingState {
  return {
    active: false,
    frameCap,
    recording: { frames: 0, events: [] },
    cursor: 0,
    prevKeys: new Set(),
    prevButtons: new Set(),
    prevPointerLocked: false,
    prevGamepadConnected: false,
    prevAxes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
  };
}

/**
 * Reset a recording state for a fresh session. Zeroes cursor + recording
 * + prev-frame trackers so the first tick after a reset emits a clean
 * "from-empty" baseline.
 */
export function resetInputRecording(state: InputRecordingState): void {
  state.recording = { frames: 0, events: [] };
  state.cursor = 0;
  state.prevKeys = new Set();
  state.prevButtons = new Set();
  state.prevPointerLocked = false;
  state.prevGamepadConnected = false;
  state.prevAxes = { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function axesEqual(a: { leftX: number; leftY: number; rightX: number; rightY: number }, b: { leftX: number; leftY: number; rightX: number; rightY: number }): boolean {
  return a.leftX === b.leftX && a.leftY === b.leftY && a.rightX === b.rightX && a.rightY === b.rightY;
}

/**
 * Build the recording system. `runsAfter: [INPUT_SYSTEM_ID]` so it sees the
 * post-input-system state regardless of which input source is active (real
 * DOM, virtual, simulated). Read-only — never mutates `InputBuffer`.
 */
export function createInputRecordingSystem(state: InputRecordingState): SystemDescriptor {
  return {
    id: INPUT_RECORDING_SYSTEM_ID,
    description:
      "Records InputBuffer state per tick to an InputRecording when state.active is true. Sparse: emits frames only when sticky state changes; mouse deltas always recorded when non-zero. Auto-stops when frameCap is reached. Designed for scenario harness record-and-replay.",
    buffers: [{ id: INPUT_BUFFER_ID, access: "read" }],
    // After the input source (real DOM / playback / simulated) writes
    // InputBuffer; BEFORE inputMapper drains mouseDx/mouseDy. Otherwise we'd
    // record a frame where the mouse deltas have already been zeroed.
    runsAfter: [INPUT_SYSTEM_ID],
    runsBefore: [INPUT_MAPPER_SYSTEM_ID],
    execute: ({ buffer }) => {
      if (!state.active) return;
      if (state.frameCap > 0 && state.cursor >= state.frameCap) {
        // Auto-stop on cap.
        state.active = false;
        return;
      }

      const input = readBuffer(buffer<InputBufferData>(INPUT_BUFFER_ID));
      const frame: InputFrame = { tick: state.cursor };
      let any = false;
      if (!setsEqual(input.keys, state.prevKeys)) {
        frame.keys = Array.from(input.keys).sort();
        state.prevKeys = new Set(input.keys);
        any = true;
      }
      if (input.mouseDx !== 0) { frame.mouseDx = input.mouseDx; any = true; }
      if (input.mouseDy !== 0) { frame.mouseDy = input.mouseDy; any = true; }
      if (input.pointerLocked !== state.prevPointerLocked) {
        frame.pointerLocked = input.pointerLocked;
        state.prevPointerLocked = input.pointerLocked;
        any = true;
      }
      if (input.gamepadConnected !== state.prevGamepadConnected) {
        frame.gamepadConnected = input.gamepadConnected;
        state.prevGamepadConnected = input.gamepadConnected;
        any = true;
      }
      if (!axesEqual(input.gamepadAxes, state.prevAxes)) {
        frame.gamepadAxes = { ...input.gamepadAxes };
        state.prevAxes = { ...input.gamepadAxes };
        any = true;
      }
      if (!setsEqual(input.gamepadButtons, state.prevButtons)) {
        frame.gamepadButtons = Array.from(input.gamepadButtons).sort();
        state.prevButtons = new Set(input.gamepadButtons);
        any = true;
      }
      if (any) state.recording.events.push(frame);
      state.cursor += 1;
      state.recording.frames = state.cursor;
    },
  };
}
