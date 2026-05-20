/**
 * Browser-side recording orchestration: snapshot gameplay buffers at
 * Record-press, assemble a `RecordingFile` at Stop, trigger a blob download.
 *
 * Designed to be called from `attachTopMenu` in `world.ts` for both free
 * play and scenario playback modes. The pure file-format details are in
 * `src/lib/testing/recordingFile.ts`; this module is the runtime bridge.
 *
 * Anything render-side (Three.js handles, DOM refs, terrain mesh,
 * worldData scene assets) is OUT of the snapshot — those get rebuilt by
 * the world bundle on load. The allowlist below is the deterministic
 * gameplay set; if you add a new gameplay buffer, add it here.
 */
import { readBuffer } from "../runtime/buffer";
import type { Registry } from "../runtime/registry";
import {
  RECORDING_FILE_VERSION,
  snapshotBufferForRecording,
  defaultRecordingFilename,
  type RecordingFile,
  type ScenarioContext,
  type SerializedHeightmap,
} from "../lib/testing/recordingFile";
import type { SnapshotValue } from "../lib/testing/bufferSnapshot";
import {
  SURFACE_PROVIDER_BUFFER_ID,
  type SurfaceProviderBufferData,
} from "../buffers/surfaceProvider";
import { HeightmapSurfaceProvider } from "../world/surfaceProvider";
import type { InputRecording } from "../systems/testing/inputPlayback";

/**
 * Gameplay-deterministic buffer ids. Snapshot these at Record-press; the
 * replay machinery seeds them back into the registry before playing the
 * input timeline. Anything scene-side or DOM-side is excluded.
 *
 * If you add a new gameplay buffer that affects controller behavior, add
 * its id here. If you add a buffer that holds class instances (THREE.*,
 * DOM elements, SurfaceProvider — like `renderRefs`, `worldData`,
 * `surfaceProvider` itself), DO NOT add it; either snapshot via a
 * dedicated path (see `snapshotSurface`) or skip it entirely.
 */
export const RECORDING_BUFFER_ALLOWLIST: readonly string[] = [
  "entity",
  "transform",
  "velocity",
  "forceAccumulator",
  "sphereBody",
  "characterController",
  "characterInput",
  "characterTangentInput",
  "surfaceAttachment",
  "characterControllerProfile",
  "camera",
  "stateMachine",
  "volumeField",
  "input",
  "inputMap",
] as const;

/**
 * Snapshot every gameplay buffer in the allowlist. Throws if a buffer is
 * not registered — that's a contract violation the caller should hear about.
 */
export function snapshotGameplayBuffers(reg: Registry): Record<string, SnapshotValue> {
  const out: Record<string, SnapshotValue> = {};
  for (const id of RECORDING_BUFFER_ALLOWLIST) {
    const buf = reg.getBuffer<unknown>(id);
    out[id] = snapshotBufferForRecording(readBuffer(buf));
  }
  return out;
}

/**
 * Extract the surface description from the live `SurfaceProviderBuffer`.
 * The provider itself is a class instance with a runtime-precomputed vertex
 * normal cache; we serialize only its inputs (width, height, tileSize, the
 * raw height field) and rehydrate the provider on load.
 *
 * Returns `null` when no surface is bound — scenes without a surface
 * provider (rare today) record with no surface.
 */
export function snapshotSurface(reg: Registry): SerializedHeightmap | null {
  const sp = readBuffer(
    reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID),
  );
  const provider = sp.heightmap;
  if (!provider) return null;
  if (provider instanceof HeightmapSurfaceProvider) {
    return {
      kind: "heightmap",
      id: provider.id,
      width: provider.heightmap.width,
      height: provider.heightmap.height,
      tileSize: provider.heightmap.tileSize,
      data: Array.from(provider.heightmap.data),
    };
  }
  throw new Error(
    `snapshotSurface: provider class "${(provider as object).constructor.name}" not supported; ` +
      `only HeightmapSurfaceProvider is serializable today.`,
  );
}

/**
 * Latched state for a single recording session. Created at Record-press
 * by `beginRecordingSnapshot`; consumed by `finalizeRecording` at Stop.
 *
 * Pure data — no DOM, no listeners. The browser-side UI in `world.ts`
 * holds one of these in a closure for the active recording.
 */
export interface RecordingSnapshotInProgress {
  initialBuffers: Record<string, SnapshotValue>;
  surface: SerializedHeightmap | null;
  scenarioContext: ScenarioContext;
}

/**
 * Capture initial conditions at the moment Record is pressed. The caller
 * then activates `InputRecordingSystem`; both halves come together in
 * `finalizeRecording`.
 */
export function beginRecordingSnapshot(args: {
  reg: Registry;
  sceneName: string | null;
  scenarioName: string | null;
  /** Scheduler `now` (ms). */
  nowMs: number;
  /** Current scheduler tick (informational). */
  tickIndex: number;
  /** Tick step in seconds. Default 1/60. */
  dtSeconds?: number;
}): RecordingSnapshotInProgress {
  return {
    initialBuffers: snapshotGameplayBuffers(args.reg),
    surface: snapshotSurface(args.reg),
    scenarioContext: {
      sceneName: args.sceneName,
      scenarioName: args.scenarioName,
      recordedAtUtc: new Date().toISOString(),
      recordedAtMs: args.nowMs,
      tickIndex: args.tickIndex,
      dtSeconds: args.dtSeconds ?? 1 / 60,
    },
  };
}

/**
 * Combine the latched snapshot with the input timeline + frame count into
 * a serializable `RecordingFile`. The file is JSON-safe (Infinity is
 * sentinel-tagged inside `snapshotBufferForRecording`).
 */
export function finalizeRecording(
  inProgress: RecordingSnapshotInProgress,
  events: InputRecording,
): RecordingFile {
  return {
    version: RECORDING_FILE_VERSION,
    scenarioContext: inProgress.scenarioContext,
    initialBuffers: inProgress.initialBuffers,
    surface: inProgress.surface,
    events: events.events,
    frames: events.frames,
  };
}

/**
 * Trigger a browser blob-download of a `RecordingFile`. Filename derives
 * from the scenario context's scene name; user gets a save dialog.
 */
export function downloadRecording(file: RecordingFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultRecordingFilename(
    file.scenarioContext.sceneName ?? file.scenarioContext.scenarioName,
  );
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
