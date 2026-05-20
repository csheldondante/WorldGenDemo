# `scenarios/recordings/` — captured-replay fixtures

This directory holds recorded gameplay slices. Each `.recording.json` file is
a self-contained replay fixture: a snapshot of every gameplay buffer at
record-start, the surface description, the input timeline, and the metadata
needed to deterministically reproduce the slice in tests.

The on-disk format is defined in
[`src/lib/testing/recordingFile.ts`](../../src/lib/testing/recordingFile.ts).
The current format version is `1`.

## How to create a recording

1. Open the world (free play or scenario) in the browser.
2. Get the character into the state you want to capture (move, position,
   FSM state, etc.).
3. Click **⏺ record** in the top-bar. A snapshot of every gameplay buffer is
   taken at that instant. From here forward your inputs are captured.
4. Play through the behavior you want to capture.
5. Click **⏹ stop + save** (or hit Esc). A `.recording.json` file is
   downloaded by the browser. Filename: `<scene>-<UTC>.recording.json`.
6. Move the downloaded file into this directory with a descriptive name,
   e.g. `tall-wall-low-speed-launch.recording.json`.

The Record button works in **both** free play and scenario playback. In
free play it just starts recording immediately. In scenario playback it
also swaps the input source from the scenario's pre-recorded input to your
live keyboard / gamepad.

## Filename convention

`<short-descriptive-name>.recording.json`. Use kebab-case. The original
download name is fine too if its descriptive enough.

## Authoring a regression test from a recording

```ts
// tests/recordings/tall-wall-launch.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bufferTestFromRecording } from "../../src/app/recordingTest";
import { runBufferTest } from "../../src/app/bufferTest";

describe("tall-wall low-speed launch", () => {
  it("replays without diverging from the captured trajectory", () => {
    const path = resolve(__dirname, "../../scenarios/recordings/tall-wall-low-speed-launch.recording.json");
    const recording = JSON.parse(readFileSync(path, "utf-8"));
    const test = bufferTestFromRecording(recording);
    const result = runBufferTest(test);
    // The first time you run this, capture a baseline:
    //   const baseline = deriveBaselineFromCapture(test.name, result.captured);
    //   writeFileSync(baselinePath, JSON.stringify(baseline));
    // From then on, the test fails whenever the trajectory diverges.
    expect(result.flags).toEqual([]);
  });
});
```

## What's in a recording

A `RecordingFile` contains:

- **`scenarioContext`** — scene name (free play) or scenario name (playback),
  UTC + scheduler-now timestamps, tick step in seconds.
- **`initialBuffers`** — snapshot of every buffer in
  `RECORDING_BUFFER_ALLOWLIST` (see
  [`src/app/recording.ts`](../../src/app/recording.ts) for the list).
  Includes Infinity values for profile curves via sentinel-tagging.
- **`surface`** — heightmap descriptor (`width × height` heights + tileSize +
  surface id). Rehydrated as a `HeightmapSurfaceProvider` on replay.
- **`events`** — sparse input timeline, identical to `InputRecording.events`.
- **`frames`** — total tick count captured.

Render-side state (Three.js handles, DOM refs, terrain mesh, world-data
scene metadata) is **not** in the recording — those get rebuilt by the world
bundle at replay time.

## Determinism guarantees

The round-trip
[`tests/app/recordingTest.test.ts`](../../tests/app/recordingTest.test.ts)
proves that:

- snapshot → JSON → parse → restore → tick is identical to
  snapshot → restore → tick (in-memory).
- The replay's end-state matches the live recording's end-state buffer-for-
  buffer (no per-leaf tolerance applied — they should be exact).
