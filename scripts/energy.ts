/**
 * Per-frame total mechanical energy trace around the climb-tall-wall launch.
 * Unit mass, g=9.81. If the controller is conserving energy (modulo
 * controlled biomechanical input thrust) the total should grow at a
 * roughly steady rate from input work, not spike at the wall contact.
 *
 *   npx vite-node scripts/energy.ts <path-to-recording.json>
 */
import { readFileSync } from "node:fs";
import { bufferTestFromRecording } from "../src/app/recordingTest";
import { runBufferTest } from "../src/app/bufferTest";
import type { RecordingFile } from "../src/lib/testing/recordingFile";

const G = 9.81;
const path =
  process.argv[2] ?? "scenarios/recordings/climb-tall-wall-2026-05-20T00-43-28Z.recording.json";
const recording = JSON.parse(readFileSync(path, "utf-8")) as RecordingFile;
const test = bufferTestFromRecording(recording, {
  outputBuffers: ["transform", "velocity", "characterController", "characterControllerDebug"],
});
(test as { enableDebugBuffers?: string[] }).enableDebugBuffers = ["characterControllerDebug"];
const result = runBufferTest(test, { recordOnly: true });
const hist = (result.captured.characterControllerDebug as {
  byEntity: Record<string, { history: Array<Record<string, number>> }>;
}).byEntity["1"].history;

// Print rows from a buffer before the slope onset (last row of slope=0)
// through max-Y row.
let onsetRow = -1;
for (let i = 1; i < hist.length; i++) {
  if (hist[i - 1].slopeRad < 0.05 && hist[i].slopeRad > 0.5) {
    onsetRow = i;
    break;
  }
}
let maxYRow = 0;
let maxY = -Infinity;
for (let i = 0; i < hist.length; i++) {
  if (hist[i].posY > maxY) { maxY = hist[i].posY; maxYRow = i; }
}
const start = Math.max(0, onsetRow - 8);
const end = Math.min(hist.length, maxYRow + 5);
console.log(`onset row=${onsetRow} tick=${hist[onsetRow].tick.toFixed(0)}ms ; maxY row=${maxYRow} posY=${maxY.toFixed(4)}`);

console.log(
  "\nrow | tick    | posY     | |v|     |     KE  |    PE  |  TOTAL  | dTOTAL    | dPE     | dKE",
);
let prev: { total: number; ke: number; pe: number } | null = null;
for (let i = start; i < end; i++) {
  const r = hist[i];
  const v2 = r.velX * r.velX + r.velY * r.velY + r.velZ * r.velZ;
  const ke = 0.5 * v2;
  const pe = G * r.posY;
  const total = ke + pe;
  const dTotal = prev ? total - prev.total : 0;
  const dPE = prev ? pe - prev.pe : 0;
  const dKE = prev ? ke - prev.ke : 0;
  const mark =
    i === onsetRow ? " <<onset" : i === maxYRow ? " <<MAX-Y" : "";
  console.log(
    String(i).padStart(3) + " | " +
    r.tick.toFixed(0).padStart(7) + " | " +
    r.posY.toFixed(4).padStart(8) + " | " +
    Math.sqrt(v2).toFixed(3).padStart(7) + " | " +
    ke.toFixed(3).padStart(7) + " | " +
    pe.toFixed(3).padStart(7) + " | " +
    total.toFixed(3).padStart(7) + " | " +
    dTotal.toFixed(3).padStart(8) + " | " +
    dPE.toFixed(3).padStart(7) + " | " +
    dKE.toFixed(3).padStart(7) + mark,
  );
  prev = { total, ke, pe };
}
