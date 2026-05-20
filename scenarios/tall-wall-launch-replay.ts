/**
 * Replay of the saved recording at
 * `scenarios/recordings/climb-tall-wall-2026-05-20T00-43-28Z.recording.json`.
 *
 * The recording captures the climb-tall-wall scene driven by a user keyboard
 * session that includes the "wall-down-onto-floor launch" bug. Loading this
 * scenario in the browser (`?scenario=tall-wall-launch-replay`) replays the
 * recorded input deterministically so the visible launch can be re-observed.
 *
 * Built from the recording via `bufferTestFromRecording`, so the same
 * harness used for headless tests drives the browser playback. The output
 * snapshot list is the recording-default set (transform, velocity,
 * characterController, etc. — characterControllerProfile excluded because
 * it contains Infinity values the snapshot encoder rejects).
 */
import recording from "./recordings/climb-tall-wall-2026-05-20T00-43-28Z.recording.json";
import type { RecordingFile } from "../src/lib/testing/recordingFile";
import { bufferTestFromRecording } from "../src/app/recordingTest";

export const test = bufferTestFromRecording(recording as unknown as RecordingFile, {
  name: "tall-wall-launch-replay",
  // Same backdrop config the source climb-tall-wall scenario uses — render
  // the heightmap as a wireframe so the visible launch is actually visible.
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 60, axisGizmo: true },
});
