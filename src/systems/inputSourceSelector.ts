/**
 * InputSourceSelectorSystem — observes `activeMode` and applies the
 * matching input source + recording flag. Moves the imperative swap
 * that used to live in DOM click handlers (= `attachTopMenu`'s
 * `swapToLive` / `swapToPlayback`) into a registered system reading
 * from a data buffer. Per user 2026-05-23:
 *
 *   "almost every complex game state change should basically just be
 *    a set of systems that get toggled on or off and rebuild of the
 *    system graph (or load cached for a given set)"
 *
 * This is the small-scope variant: the system swap is still imperative
 * (`reg.replaceSystem(...)`), but it's triggered by an observable data
 * change (activeMode) inside a registered system, not by a DOM event
 * handler. The fuller variant (= each mode's `systems` list contains
 * a different input system id, mode swap rebuilds the graph naturally)
 * needs a rename pass on the input system IDs and downstream `runsAfter`
 * lists — tracked as future work.
 */

import { readBuffer } from "../runtime/buffer";
import type { Registry } from "../runtime/registry";
import type { SystemDescriptor } from "../runtime/system";
import {
  STATE_MACHINE_BUFFER_ID,
  STATE_MACHINE_SYSTEM_ID,
  type StateMachineBufferData,
} from "../runtime/stateMachine";
import type { InputRecordingState } from "./testing/inputRecording";
import { resetInputRecording } from "./testing/inputRecording";

export const INPUT_SOURCE_SELECTOR_SYSTEM_ID = "inputSourceSelectorSystem";

export interface InputSourceSpec {
  /** The input system descriptor to install at its declared id when
   *  this mode becomes active. Must already be a registered system —
   *  this triggers `reg.replaceSystem(input)` to swap the in-place
   *  descriptor. */
  input: SystemDescriptor;
  /** Whether the recording system should accumulate frames while this
   *  mode is active. Default false. */
  recording?: boolean;
}

export interface InputSourceSelectorOptions {
  /** Mode id → input source spec. Mode ids not in this map don't
   *  trigger a swap (= activeMode change is ignored). */
  modes: Record<string, InputSourceSpec>;
  /** The recording state object owned by `registerCoreSystems`. The
   *  selector flips `state.active` based on the active mode's spec
   *  and resets the recording log on every entry into a recording
   *  mode (= fresh session per click). */
  recordingState: InputRecordingState;
  /** Optional callback fired when leaving a recording mode (= flush
   *  the recording to console / file / wherever the host wants). */
  onRecordingComplete?: (state: InputRecordingState) => void;
}

/**
 * Build the selector. Closes over the registry so it can call
 * `replaceSystem` from `execute` — same pattern as
 * `createLibraryViewerSystem(reg)` (= reg-closing factory is the
 * existing convention for systems that need registry-level access
 * beyond per-buffer reads).
 *
 * Idempotent re-observation: tracks the last-seen `activeMode` in the
 * closure; only acts when it changes. Safe to leave registered in any
 * graph — modes not in the map are no-ops.
 */
export function createInputSourceSelectorSystem(
  reg: Registry,
  opts: InputSourceSelectorOptions,
): SystemDescriptor {
  let lastMode: string | null = null;
  return {
    id: INPUT_SOURCE_SELECTOR_SYSTEM_ID,
    description:
      "Observes StateMachineBuffer.activeMode and, when it enters a mode listed in the input-source map, swaps the input system descriptor and sets the recording state's active flag. Bridges mode-cycling UI to the input pipeline; replaces imperative replaceSystem calls from DOM event handlers.",
    buffers: [{ id: STATE_MACHINE_BUFFER_ID, access: "read" }],
    // Run after the SM has updated activeMode this tick.
    runsAfter: [STATE_MACHINE_SYSTEM_ID],
    execute: ({ buffer }) => {
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      const mode = sm.activeMode;
      if (mode === lastMode) return;
      const prevMode = lastMode;
      lastMode = mode;

      // If the prior mode was a recording mode and we're leaving it,
      // fire the completion callback BEFORE clearing the active flag.
      const prevSpec = prevMode !== null ? opts.modes[prevMode] : undefined;
      const wasRecording = prevSpec?.recording === true && opts.recordingState.active;

      const spec = opts.modes[mode];
      if (!spec) {
        // Active mode isn't a managed input-source mode. Don't touch
        // the input system or recording flag (= might be LibraryViewer
        // overlay, scene mode, etc.).
        if (wasRecording) {
          opts.recordingState.active = false;
          opts.onRecordingComplete?.(opts.recordingState);
        }
        return;
      }

      reg.replaceSystem(spec.input);
      const willRecord = spec.recording === true;
      if (willRecord && !opts.recordingState.active) {
        // Fresh session each entry into a recording mode.
        resetInputRecording(opts.recordingState);
      }
      opts.recordingState.active = willRecord;
      if (wasRecording && !willRecord) {
        opts.onRecordingComplete?.(opts.recordingState);
      }
    },
  };
}
