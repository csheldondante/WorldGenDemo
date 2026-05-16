/**
 * Live input recording system. Runs AFTER the real `inputSystem` (or any
 * `INPUT_SYSTEM_ID` provider) and snapshots `InputBuffer` per tick into an
 * in-memory `InputRecording`. On scenario stop the recording is serialized to
 * disk (caller-provided callback) so a player session becomes a replayable
 * test artifact.
 *
 * The recording is sparse: each tick the system diffs against the previous
 * frame and emits a frame entry only when something CHANGED (or for mouseDx/Dy
 * any non-zero deltas, which are always one-shot). This keeps recordings
 * compact even for long sessions.
 *
 * Recorded format matches `InputRecording` consumed by `inputPlaybackSystem`,
 * so record-then-play round-trips cleanly.
 */
import type { SystemDescriptor } from "../../runtime/system";
import { readBuffer } from "../../runtime/buffer";
import { INPUT_BUFFER_ID, type InputBufferData } from "../../buffers/input";
import { INPUT_SYSTEM_ID } from "../input";
import type { InputFrame, InputRecording } from "./inputPlayback";

export const INPUT_RECORDING_SYSTEM_ID = "inputRecordingSystem";

/** Shared mutable recording accumulator handed back to the caller for serialization. */
export interface InputRecordingState {
  recording: InputRecording;
}

/** Initialize an empty recording state. Pass to `createInputRecordingSystem(state)`. */
export function createInputRecordingState(): InputRecordingState {
  return { recording: { frames: 0, events: [] } };
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
 * DOM, virtual, simulated). The buffer access is read-only — we never mutate
 * `InputBuffer` here.
 */
export function createInputRecordingSystem(state: InputRecordingState): SystemDescriptor {
  let cursor = 0;
  let prevKeys = new Set<string>();
  let prevButtons = new Set<string>();
  let prevPointerLocked = false;
  let prevGamepadConnected = false;
  let prevAxes = { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
  return {
    id: INPUT_RECORDING_SYSTEM_ID,
    description:
      "Records InputBuffer state per tick to an InputRecording. Runs after the active inputSystem to capture whatever source it provided (real DOM, virtual, simulated). Emits sparse frames only when sticky state changes; mouse deltas always recorded when non-zero.",
    buffers: [{ id: INPUT_BUFFER_ID, access: "read" }],
    runsAfter: [INPUT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const input = readBuffer(buffer<InputBufferData>(INPUT_BUFFER_ID));
      const frame: InputFrame = { tick: cursor };
      let any = false;
      if (!setsEqual(input.keys, prevKeys)) {
        frame.keys = Array.from(input.keys).sort();
        prevKeys = new Set(input.keys);
        any = true;
      }
      if (input.mouseDx !== 0) { frame.mouseDx = input.mouseDx; any = true; }
      if (input.mouseDy !== 0) { frame.mouseDy = input.mouseDy; any = true; }
      if (input.pointerLocked !== prevPointerLocked) {
        frame.pointerLocked = input.pointerLocked;
        prevPointerLocked = input.pointerLocked;
        any = true;
      }
      if (input.gamepadConnected !== prevGamepadConnected) {
        frame.gamepadConnected = input.gamepadConnected;
        prevGamepadConnected = input.gamepadConnected;
        any = true;
      }
      if (!axesEqual(input.gamepadAxes, prevAxes)) {
        frame.gamepadAxes = { ...input.gamepadAxes };
        prevAxes = { ...input.gamepadAxes };
        any = true;
      }
      if (!setsEqual(input.gamepadButtons, prevButtons)) {
        frame.gamepadButtons = Array.from(input.gamepadButtons).sort();
        prevButtons = new Set(input.gamepadButtons);
        any = true;
      }
      if (any) state.recording.events.push(frame);
      cursor += 1;
      state.recording.frames = cursor;
    },
  };
}
