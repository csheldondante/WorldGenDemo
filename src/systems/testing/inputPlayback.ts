/**
 * Scenario input playback — drop-in for `inputSystem` (same id = `INPUT_SYSTEM_ID`).
 * Reads a pre-recorded timeline and copies the matching frame's input state
 * into `InputBuffer` each tick. Downstream systems (inputMapper, characterInput,
 * controllers) see identical buffer state to a real player session, so the
 * scenario exercises the full real input pipeline.
 *
 * The timeline is a sparse sticky-key/mouse-delta sequence:
 *   keys/buttons (Set) carry forward until an event removes them.
 *   mouseDx/mouseDy (numbers) are one-shot — applied this frame, then zeroed.
 *
 * Storage format: plain JSON-serializable `InputRecording` so scenarios can
 * ship recorded sessions next to their baselines.
 */
import type { SystemDescriptor } from "../../runtime/system";
import { writeBuffer } from "../../runtime/buffer";
import { INPUT_BUFFER_ID, type InputBufferData } from "../../buffers/input";
import { SCRIPTED_INPUT_SYSTEM_ID } from "../input";

/**
 * One frame of recorded input state. Sets are serialized as sorted arrays;
 * sticky values (keys, gamepadButtons, gamepadAxes, pointerLocked, gamepadConnected)
 * persist if absent from the next frame.
 */
export interface InputFrame {
  /** Tick index (0-based). Frames must be sorted ascending. */
  tick: number;
  /** Held keys (replaces the entire set). Optional → sticky. */
  keys?: string[];
  /** Mouse deltas — applied to this frame only, then auto-zeroed. */
  mouseDx?: number;
  mouseDy?: number;
  /** Sticky pointer-lock state. */
  pointerLocked?: boolean;
  /** Sticky gamepad connection. */
  gamepadConnected?: boolean;
  /** Sticky stick axes. */
  gamepadAxes?: { leftX: number; leftY: number; rightX: number; rightY: number };
  /** Held buttons (replaces the entire set). Optional → sticky. */
  gamepadButtons?: string[];
}

export interface InputRecording {
  /** Total frame count for this recording. */
  frames: number;
  /** Sparse list of input changes; absent frames carry forward sticky state. */
  events: InputFrame[];
}

/**
 * Build a playback system that drives `InputBuffer` from an `InputRecording`.
 * Maintains its own "current frame" counter — advances one frame per tick.
 * When the recording is exhausted the last sticky state is held; mouseDx/Dy
 * always zero past the end. Caller decides when to stop the scenario.
 */
export function createInputPlaybackSystem(recording: InputRecording): SystemDescriptor {
  // Build a tick → frame lookup once.
  const byTick = new Map<number, InputFrame>();
  for (const f of recording.events) byTick.set(f.tick, f);

  // Cached sticky state — updated each frame, copied into InputBuffer.
  const state = {
    keys: new Set<string>(),
    pointerLocked: false,
    gamepadConnected: false,
    gamepadAxes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
    gamepadButtons: new Set<string>(),
  };
  let cursor = 0;

  return {
    id: SCRIPTED_INPUT_SYSTEM_ID,
    description:
      "Scenario playback input source. Sibling of inputSystem under SCRIPTED_INPUT_SYSTEM_ID: reads a recorded InputRecording timeline + advances one frame per tick, copying state into InputBuffer. Sticky keys/buttons/axes carry forward; mouseDx/Dy are one-shot per frame.",
    buffers: [{ id: INPUT_BUFFER_ID, access: "readwrite" }],
    execute: ({ buffer }) => {
      const frame = byTick.get(cursor);
      let mouseDx = 0;
      let mouseDy = 0;
      if (frame) {
        if (frame.keys !== undefined) state.keys = new Set(frame.keys);
        if (frame.pointerLocked !== undefined) state.pointerLocked = frame.pointerLocked;
        if (frame.gamepadConnected !== undefined) state.gamepadConnected = frame.gamepadConnected;
        if (frame.gamepadAxes !== undefined) state.gamepadAxes = { ...frame.gamepadAxes };
        if (frame.gamepadButtons !== undefined) state.gamepadButtons = new Set(frame.gamepadButtons);
        if (frame.mouseDx !== undefined) mouseDx = frame.mouseDx;
        if (frame.mouseDy !== undefined) mouseDy = frame.mouseDy;
      }
      writeBuffer(buffer<InputBufferData>(INPUT_BUFFER_ID), (d) => {
        d.keys = new Set(state.keys);
        d.mouseDx = mouseDx;
        d.mouseDy = mouseDy;
        d.pointerLocked = state.pointerLocked;
        d.gamepadConnected = state.gamepadConnected;
        d.gamepadAxes = { ...state.gamepadAxes };
        d.gamepadButtons = new Set(state.gamepadButtons);
      });
      cursor += 1;
    },
  };
}
