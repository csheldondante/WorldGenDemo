/**
 * Save-mode CLI. Phase 7b of modes-and-modules (docs/modes-and-modules.md).
 *
 *   npx vite-node scripts/saveMode.ts <modeId> <outFile> [--scene=<name>] [--ticks=<n>]
 *
 * Boots the runtime headless, optionally loads a scene + runs N ticks,
 * then serializes the mode's owned + shared buffers into a JSON file.
 *
 * Default: scene = canyon-desert, ticks = 0 (= save initial state).
 *
 * The output file format is `ModeSnapshot` from
 * `src/runtime/modeSnapshot.ts` — same JSON dialect as scenario
 * baselines.
 *
 * Use cases:
 *   - Save current "feel" tweaks (= ProfileEditor sessions) as a
 *     reusable starting point.
 *   - Capture a fully-loaded scene state for fast reload in
 *     subsequent runs.
 *   - Archive a scenario's runtime state mid-playback for inspection.
 */

import { resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { bootstrapApp } from "../src/app/bootstrap";
import { executeGraph } from "../src/runtime/scheduler";
import { getOrBuildGraphForMode } from "../src/runtime/mode";
import { readBuffer } from "../src/runtime/buffer";
import { serializeMode } from "../src/runtime/modeSnapshot";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../src/runtime/stateMachine";

interface CliFlags {
  modeId?: string;
  outFile?: string;
  scene: string;
  ticks: number;
  waitForRunning: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { scene: "canyon-desert", ticks: 0, waitForRunning: false };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--scene=")) flags.scene = arg.slice("--scene=".length);
    else if (arg.startsWith("--ticks=")) flags.ticks = parseInt(arg.slice("--ticks=".length), 10) || 0;
    else if (arg === "--wait-for-running") flags.waitForRunning = true;
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  flags.modeId = positional[0];
  flags.outFile = positional[1];
  return flags;
}

function usage(): void {
  // eslint-disable-next-line no-console
  console.error(
    "usage: vite-node scripts/saveMode.ts <modeId> <outFile> [--scene=<name>] [--ticks=<n>] [--wait-for-running]\n" +
      "  modeId             — registered mode id (= e.g. 'Running').\n" +
      "  outFile            — path to write the ModeSnapshot JSON.\n" +
      "  --scene            — scene to load (default 'canyon-desert').\n" +
      "  --ticks            — ticks to run after bootstrap (default 0).\n" +
      "  --wait-for-running — block until SM.state === Running before serializing.\n" +
      "                       Requires network fetches to succeed (= browser context),\n" +
      "                       so headless node runs usually omit this flag.",
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.modeId || !flags.outFile) {
    usage();
    process.exit(2);
  }

  const app = bootstrapApp({ sceneName: flags.scene });
  const reg = app.registry;
  if (!reg.hasMode(flags.modeId)) {
    // eslint-disable-next-line no-console
    console.error(`saveMode: mode '${flags.modeId}' is not registered. Available modes:`);
    for (const m of reg.listModes()) console.error(`  ${m.id}  (tags: ${(m.tags ?? []).join(", ") || "none"})`);
    process.exit(2);
  }

  const smBuf = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
  let bootTicks = 0;
  if (flags.waitForRunning) {
    // Caller wants the world fully loaded. Requires LoadSceneSystem's
    // fetch to resolve — works in browser context but typically fails
    // headlessly. Cap at 1000 ticks to avoid infinite loops.
    const MAX_BOOT_TICKS = 1000;
    while (bootTicks < MAX_BOOT_TICKS) {
      const sm = readBuffer(smBuf);
      if (sm.state === "Running") break;
      const graph = getOrBuildGraphForMode(reg, sm.activeMode);
      executeGraph(graph, reg, { dt: 1 / 60, now: bootTicks * (1000 / 60) });
      bootTicks += 1;
    }
    if (bootTicks >= MAX_BOOT_TICKS) {
      // eslint-disable-next-line no-console
      console.error(`saveMode: gave up after ${MAX_BOOT_TICKS} ticks waiting for state=Running. State=${readBuffer(smBuf).state}. Remove --wait-for-running for headless saves.`);
      process.exit(2);
    }
    // eslint-disable-next-line no-console
    console.log(`[saveMode] world ready after ${bootTicks} ticks; advancing ${flags.ticks} more`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[saveMode] bootstrapped state=${readBuffer(smBuf).state}; advancing ${flags.ticks} ticks`);
  }
  for (let i = 0; i < flags.ticks; i++) {
    const sm = readBuffer(smBuf);
    const graph = getOrBuildGraphForMode(reg, sm.activeMode);
    executeGraph(graph, reg, { dt: 1 / 60, now: (bootTicks + i) * (1000 / 60) });
  }

  const snapshot = serializeMode(reg, flags.modeId);
  const outPath = resolve(process.cwd(), flags.outFile);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  // eslint-disable-next-line no-console
  console.log(`[saveMode] wrote ${outPath} (modeId=${flags.modeId}, buffers=${Object.keys(snapshot.buffers).length}, excluded=${snapshot.excluded.length})`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[saveMode] failed:", err);
  process.exit(2);
});
