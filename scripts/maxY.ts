import { readFileSync } from "node:fs";
import { bufferTestFromRecording } from "../src/app/recordingTest";
import { runBufferTest } from "../src/app/bufferTest";
import type { RecordingFile } from "../src/lib/testing/recordingFile";

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

let maxY = -Infinity;
let maxRow = 0;
for (let i = 0; i < hist.length; i++) {
  if (hist[i].posY > maxY) {
    maxY = hist[i].posY;
    maxRow = i;
  }
}
console.log(`maxY=${maxY.toFixed(4)} at row ${maxRow} tick ${hist[maxRow].tick.toFixed(0)}ms`);

const start = Math.max(0, maxRow - 55);
const end = Math.min(hist.length, maxRow + 5);
console.log(
  "\nrow | tick    | posX     | posY     | posZ     | velX     | velY     | velZ     | |v|     | slope | dPosY",
);
let prev: Record<string, number> | null = null;
for (let i = start; i < end; i++) {
  const x = hist[i];
  const sp = Math.hypot(x.velX, x.velY, x.velZ);
  const dpy = prev ? x.posY - prev.posY : 0;
  const mark = i === maxRow ? " <<MAX" : "";
  console.log(
    String(i).padStart(3) +
      " | " + x.tick.toFixed(0).padStart(7) +
      " | " + x.posX.toFixed(4).padStart(8) +
      " | " + x.posY.toFixed(4).padStart(8) +
      " | " + x.posZ.toFixed(4).padStart(8) +
      " | " + x.velX.toFixed(4).padStart(8) +
      " | " + x.velY.toFixed(4).padStart(8) +
      " | " + x.velZ.toFixed(4).padStart(8) +
      " | " + sp.toFixed(3).padStart(7) +
      " | " + x.slopeRad.toFixed(3) +
      " | " + dpy.toFixed(4).padStart(7) +
      mark,
  );
  prev = x;
}
