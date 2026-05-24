/**
 * Load-mode CLI. Phase 7b of modes-and-modules (docs/modes-and-modules.md).
 *
 *   npx vite-node scripts/loadMode.ts <inFile> [--scene=<name>]
 *
 * Boots the runtime headless, advances through the rebuild for the
 * given scene (default: canyon-desert), then restores the ModeSnapshot's
 * buffer values on top. Prints a summary of which buffers were
 * applied + a small state report (= what scene was loaded, key
 * buffer versions, character position if present).
 *
 * The output is mostly a sanity check that the round-trip works; the
 * real value of this CLI is its existence (= demonstrates the
 * serialize/restore contract). A future browser path will use the
 * same machinery to load saved sessions.
 */

import { resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { bootstrapApp } from "../src/app/bootstrap";
import { readBuffer } from "../src/runtime/buffer";
import { restoreMode, type ModeSnapshot } from "../src/runtime/modeSnapshot";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../src/runtime/stateMachine";

interface CliFlags {
  inFile?: string;
  scene: string;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { scene: "canyon-desert" };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--scene=")) flags.scene = arg.slice("--scene=".length);
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  flags.inFile = positional[0];
  return flags;
}

function usage(): void {
  // eslint-disable-next-line no-console
  console.error(
    "usage: vite-node scripts/loadMode.ts <inFile> [--scene=<name>]\n" +
      "  inFile   — ModeSnapshot JSON written by saveMode.\n" +
      "  --scene  — scene to bootstrap before restore (default 'canyon-desert').",
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.inFile) {
    usage();
    process.exit(2);
  }
  const inPath = resolve(process.cwd(), flags.inFile);
  if (!existsSync(inPath)) {
    // eslint-disable-next-line no-console
    console.error(`loadMode: file not found: ${inPath}`);
    process.exit(2);
  }
  const snapshot = JSON.parse(readFileSync(inPath, "utf-8")) as ModeSnapshot;

  const app = bootstrapApp({ sceneName: flags.scene });
  const reg = app.registry;
  if (!reg.hasMode(snapshot.modeId)) {
    // eslint-disable-next-line no-console
    console.error(`loadMode: snapshot's modeId '${snapshot.modeId}' is not registered in the current build.`);
    process.exit(2);
  }

  // registerCoreBuffers ran during bootstrapApp, so every buffer
  // exists already. restoreMode silently skips snapshot entries
  // whose buffer id isn't registered, so we don't need to wait for
  // any particular state — overwrite whatever's there.
  const smBuf = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);

  restoreMode(reg, snapshot);
  const sm = readBuffer(smBuf);
  // eslint-disable-next-line no-console
  console.log(`[loadMode] restored ${Object.keys(snapshot.buffers).length} buffers from ${inPath}`);
  // eslint-disable-next-line no-console
  console.log(`[loadMode] post-restore: smState=${sm.state} activeGraph=${sm.activeGraph} activeMode=${sm.activeMode}`);
  for (const [bufId] of Object.entries(snapshot.buffers)) {
    if (!reg.hasBuffer(bufId)) continue;
    const v = reg.getBuffer<unknown>(bufId).version;
    // eslint-disable-next-line no-console
    console.log(`  ${bufId}  (version=${v})`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[loadMode] failed:", err);
  process.exit(2);
});
