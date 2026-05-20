/**
 * Diagnostic: extract per-tick body position + velocity from a scenario's
 * captured characterControllerDebug history. Use to spot teleports / dips
 * in climb-steep-wall (Track A diagnostic, 2026-05-20).
 *
 *   npx vite-node scripts/climbTrace.ts                    # default: climb-steep-wall
 *   npx vite-node scripts/climbTrace.ts <scenario-name>    # any scenario with characterControllerDebug enabled
 */
import { runBufferTest } from "../src/app/bufferTest";
import { restoreBufferData } from "../src/lib/testing/bufferSnapshot";
import { getScenario } from "../scenarios/index";

const scenarioName = process.argv[2] ?? "climb-steep-wall";
const test = getScenario(scenarioName);
// Enable debug buffer on the fly if scenario doesn't have it.
if (!test.enableDebugBuffers) {
  test.enableDebugBuffers = ["characterControllerDebug"];
  test.output.snapshot = [...test.output.snapshot, "characterControllerDebug"];
}

// Run the scenario fresh (no baseline comparison — we just want the captured
// history). enableDebugBuffers + output.snapshot already set up by the
// scenario for climb-steep-wall.
const result = runBufferTest(test, { recordOnly: true });

const dbgRaw = result.captured.characterControllerDebug;
const dbg = dbgRaw ? (restoreBufferData(dbgRaw) as {
  byEntity: Map<number, { history: Array<Record<string, number>> }>;
}) : undefined;
if (!dbg) {
  console.error("Scenario does not capture characterControllerDebug.");
  process.exit(1);
}

const player = dbg.byEntity.get(1);
if (!player) {
  console.error("No history for entity 1.");
  process.exit(1);
}

console.log(`tick  posX    posY    posZ    velX    velY    velZ   slope  vN    aExN   aCntN  aSurf  fwdMax fwdEff`);
let prev = player.history[0];
for (let i = 0; i < player.history.length; i++) {
  const r = player.history[i];
  console.log(
    `${String(r.tick).padStart(5)}  ${r.posX.toFixed(2).padStart(6)}  ${r.posY.toFixed(2).padStart(6)}  ${r.posZ.toFixed(2).padStart(6)}  ` +
    `${r.velX.toFixed(2).padStart(6)}  ${r.velY.toFixed(2).padStart(6)}  ${r.velZ.toFixed(2).padStart(6)}  ` +
    `${(r.slopeRad ?? 0).toFixed(2).padStart(5)}  ${(r.vN ?? 0).toFixed(2).padStart(5)}  ${(r.aExN ?? 0).toFixed(2).padStart(5)}  ${(r.aCentripetalN ?? 0).toFixed(2).padStart(5)}  ${(r.aSurfaceN ?? 0).toFixed(2).padStart(5)}  ${(r.fwdMax ?? 0).toFixed(2).padStart(6)}  ${(r.aFEff ?? 0).toFixed(2).padStart(6)}`,
  );
  prev = r;
}
