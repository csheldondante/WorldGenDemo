/**
 * Build a `BufferTest` from a `RecordingFile`. The resulting test:
 *
 * 1. Seeds the registry's gameplay buffers from `recording.initialBuffers`
 *    (Infinity-tag-aware via `restoreBufferFromRecording`).
 * 2. Rehydrates the heightmap surface provider from
 *    `recording.surface` and writes it into `SurfaceProviderBuffer`.
 * 3. Drives `InputSystem` via `createInputPlaybackSystem(events)`.
 * 4. Ticks the headless gameplay system list for `recording.frames` ticks.
 * 5. Snapshots a configurable set of output buffers (default = the same
 *    gameplay set scenarios use).
 *
 * Callers (e.g. `tests/recordings/*.test.ts`) import this helper, pass a
 * file path or a parsed `RecordingFile`, and get a `BufferTest` they can
 * hand to `runBufferTest` exactly like a hand-written scenario.
 *
 * App-layer: imports across runtime / buffers / world / systems / bufferTest.
 * `recordingFile.ts` (the pure JSON shape + Infinity tagging) stays in
 * `src/lib/testing/` since it has no runtime dependencies; this builder lives
 * here because it needs the registry, the surface provider class, and the
 * existing BufferTest type.
 */
import type { Registry } from "../runtime/registry";
import { writeBuffer } from "../runtime/buffer";
import { restoreBufferFromRecording, type RecordingFile } from "../lib/testing/recordingFile";
import {
  SURFACE_PROVIDER_BUFFER_ID,
  type SurfaceProviderBufferData,
} from "../buffers/surfaceProvider";
import { HeightmapSurfaceProvider } from "../world/surfaceProvider";
import { createInputPlaybackSystem } from "../systems/testing/inputPlayback";
import type { BufferTest } from "./bufferTest";

/**
 * Default output snapshot list — every gameplay buffer worth comparing
 * across replay runs.
 *
 * Excluded by design:
 *   - `surfaceProvider`: holds a class instance the snapshot encoder
 *     refuses. The rehydrated provider is identity-checked by the rest
 *     of the gameplay state (positions, UVs, etc.) instead.
 *   - `characterControllerProfile`: contains `Infinity` in curve `vMax`
 *     fields that the snapshot encoder refuses. The profile is immutable
 *     in headless replay (the profile editor is not in the system list),
 *     so it cannot diverge — there is nothing to compare.
 */
export const RECORDING_REPLAY_OUTPUT_BUFFERS: readonly string[] = [
  "entity",
  "transform",
  "velocity",
  "forceAccumulator",
  "sphereBody",
  "characterController",
  "characterInput",
  "characterTangentInput",
  "surfaceAttachment",
  "camera",
  "stateMachine",
  "volumeField",
  "input",
  "inputMap",
];

/**
 * The headless gameplay system list — same shape `scenarios/_helpers.ts`
 * exposes as `HEADLESS_GAMEPLAY_SYSTEMS`. Duplicated here so the recording
 * library doesn't take a dependency on the scenarios folder.
 */
export const RECORDING_REPLAY_SYSTEMS: readonly string[] = [
  "stateMachineSystem",
  "inputSystem",
  "inputMapperSystem",
  "characterInputSystem",
  "tangentInputMapperSystem",
  "characterOrientationSystem",
  "forceFieldSystem",
  "characterControllerSystem",
  "surfaceConstrainedVelocitySystem",
  "volumetricConstrainedVelocitySystem",
  "surfaceConstraintSystem",
  "cameraPivotSystem",
  "cameraOrbitSystem",
  "bodyLeanSystem",
  "chainDynamicsSystem",
  "footPlannerSystem",
  "footIkSystem",
  "skeletonWorldSystem",
];

export interface RecordingTestOptions {
  /** Override the test name. Defaults to the recording's scene/scenario name. */
  name?: string;
  /** Override the snapshot buffer list. */
  outputBuffers?: readonly string[];
  /** Override the gameplay system list. */
  systemIds?: readonly string[];
  /** Override the tick count (default = recording.frames). */
  ticks?: number;
}

/**
 * Build a BufferTest fixture from a parsed RecordingFile. The returned
 * test is ready to pass to `runBufferTest` — no DOM, no Three.js.
 */
export function bufferTestFromRecording(
  recording: RecordingFile,
  opts: RecordingTestOptions = {},
): BufferTest {
  const name =
    opts.name ??
    recording.scenarioContext.scenarioName ??
    recording.scenarioContext.sceneName ??
    "recording";
  const ticks = opts.ticks ?? recording.frames;
  const dt = recording.scenarioContext.dtSeconds || 1 / 60;
  return {
    name,
    description:
      `Replay of recording captured at ${recording.scenarioContext.recordedAtUtc} ` +
      `(${recording.frames} frames, ${recording.events.length} input events).`,
    input: {
      kind: "seed",
      fn: (reg: Registry) => {
        // Rehydrate the surface first — gameplay systems read it on first tick.
        if (recording.surface && recording.surface.kind === "heightmap") {
          const provider = new HeightmapSurfaceProvider(recording.surface.id, {
            width: recording.surface.width,
            height: recording.surface.height,
            tileSize: recording.surface.tileSize,
            data: new Float32Array(recording.surface.data),
          });
          writeBuffer(
            reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID),
            (d) => {
              d.heightmap = provider;
            },
          );
        }
        // Restore every gameplay buffer from the snapshot. Buffer ids
        // missing from the registry surface as a clear error rather than a
        // silent skip — recordings shouldn't reference unregistered buffers.
        for (const [bufId, snap] of Object.entries(recording.initialBuffers)) {
          if (!reg.hasBuffer(bufId)) {
            throw new Error(
              `bufferTestFromRecording: recording references unregistered buffer "${bufId}"`,
            );
          }
          const restored = restoreBufferFromRecording(snap);
          const buf = reg.getBuffer<unknown>(bufId);
          writeBuffer(buf, () => restored);
        }
      },
    },
    inputSystem: createInputPlaybackSystem({
      frames: recording.frames,
      events: recording.events,
    }),
    steps: [
      {
        kind: "tickSystems",
        systemIds: [...(opts.systemIds ?? RECORDING_REPLAY_SYSTEMS)],
        ticks,
        dt,
      },
    ],
    output: {
      snapshot: [...(opts.outputBuffers ?? RECORDING_REPLAY_OUTPUT_BUFFERS)],
    },
  };
}
