/**
 * Replay a saved recording with characterControllerDebug enabled, then dump
 * every wall-contact / slope-onset region so we can spot what produces the
 * visible launch.
 *
 *   npx vite-node scripts/traceRecording.ts <path-to-recording.json>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bufferTestFromRecording } from "../src/app/recordingTest";
import { runBufferTest } from "../src/app/bufferTest";
import type { RecordingFile } from "../src/lib/testing/recordingFile";

const path = resolve(
  process.argv[2] ?? "scenarios/recordings/climb-tall-wall-2026-05-20T00-43-28Z.recording.json",
);
const recording = JSON.parse(readFileSync(path, "utf-8")) as RecordingFile;
console.log(`[trace] ${path}`);
console.log(`[trace] frames=${recording.frames} events=${recording.events.length}`);

const test = bufferTestFromRecording(recording, {
  outputBuffers: [
    "transform",
    "velocity",
    "characterController",
    "surfaceAttachment",
    "characterControllerDebug",
  ],
});
(test as { enableDebugBuffers?: string[] }).enableDebugBuffers = ["characterControllerDebug"];

const result = runBufferTest(test, { recordOnly: true });
const dbg = result.captured.characterControllerDebug as {
  byEntity: Record<string, { history: Array<Record<string, number>> }>;
};
const ent = dbg.byEntity["1"];
if (!ent || !ent.history) {
  console.error("no debug history captured");
  process.exit(2);
}
const hist = ent.history;
console.log(`[trace] history rows=${hist.length}`);

// Find every "slope shoots up" event (slopeRad goes from < 0.1 to > 0.5 in
// a small number of rows). These are the wall-contact moments.
const onsets: number[] = [];
for (let i = 5; i < hist.length; i++) {
  const cur = hist[i].slopeRad;
  const prev = hist[i - 5].slopeRad;
  if (prev < 0.1 && cur > 0.5) {
    // Filter: only first row in a cluster of onset rows.
    if (onsets.length === 0 || i - onsets[onsets.length - 1] > 20) onsets.push(i);
  }
}
console.log(`[trace] slope onsets at rows: ${onsets.join(", ")} (each = ~slope rises from flat to steep)`);

// Dump 20 rows around each onset.
for (const onset of onsets) {
  const start = Math.max(0, onset - 5);
  const end = Math.min(hist.length, onset + 25);
  console.log(`\n=== onset around row ${onset} (tick ~${hist[onset].tick.toFixed(0)}ms) ===`);
  console.log("row | tick    | posX     | posY     | posZ     | velX     | velY     | velZ     | |v|     | slope");
  let prevSpeed = Math.hypot(hist[start].velX, hist[start].velY, hist[start].velZ);
  for (let i = start; i < end; i++) {
    const r = hist[i];
    const sp = Math.hypot(r.velX, r.velY, r.velZ);
    const dSp = sp - prevSpeed;
    const flag = dSp > 2 ? " <<SPIKE>>" : "";
    console.log(
      String(i).padStart(3) + " | " + r.tick.toFixed(1).padStart(7) + " | " +
      r.posX.toFixed(4).padStart(8) + " | " + r.posY.toFixed(4).padStart(8) + " | " + r.posZ.toFixed(4).padStart(8) + " | " +
      r.velX.toFixed(4).padStart(8) + " | " + r.velY.toFixed(4).padStart(8) + " | " + r.velZ.toFixed(4).padStart(8) + " | " +
      sp.toFixed(3).padStart(7) + " | " + r.slopeRad.toFixed(3).padStart(5) + flag,
    );
    prevSpeed = sp;
  }
}

// Also dump per-tick speed delta to find big positive jumps.
console.log(`\n[trace] all rows where |v| jumps by > 3 in one tick:`);
console.log("row | tick    | |v|prev | |v|now  | delta  | velX     | velY     | velZ     | slope");
let prev = Math.hypot(hist[0].velX, hist[0].velY, hist[0].velZ);
for (let i = 1; i < hist.length; i++) {
  const sp = Math.hypot(hist[i].velX, hist[i].velY, hist[i].velZ);
  const d = sp - prev;
  if (d > 3) {
    const r = hist[i];
    console.log(
      String(i).padStart(3) + " | " + r.tick.toFixed(1).padStart(7) + " | " +
      prev.toFixed(3).padStart(7) + " | " + sp.toFixed(3).padStart(7) + " | " + d.toFixed(3).padStart(6) + " | " +
      r.velX.toFixed(4).padStart(8) + " | " + r.velY.toFixed(4).padStart(8) + " | " + r.velZ.toFixed(4).padStart(8) + " | " +
      r.slopeRad.toFixed(3),
    );
  }
  prev = sp;
}
