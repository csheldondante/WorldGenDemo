/**
 * Scenario CLI runner — buffer-snapshot test framework.
 *
 *   npx vite-node scripts/runScenario.ts <name>            # run + diff vs baseline
 *   npx vite-node scripts/runScenario.ts <name> --record   # record fresh baseline
 *   npx vite-node scripts/runScenario.ts <name> --json     # dump captured buffers
 *   npx vite-node scripts/runScenario.ts --list            # list available scenarios
 *
 * Exit codes:
 *   0 — no flags (clean run, or successful --record).
 *   2 — flags present (review required) OR harness error.
 *
 * Baselines live in `scenarios/__baselines__/<name>.json`. Baseline file is a
 * `BaselineFile` (see src/app/bufferTest.ts): captured buffer tree + per-path
 * tolerance overrides. The recorder writes an empty overrides map; the human
 * edits in widenings post-hoc with justification.
 *
 * Re-recording is gated — `--record` over an existing baseline requires `--force`.
 */
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { runBufferTest, deriveBaselineFromCapture, type BaselineFile } from "../src/app/bufferTest";
import { formatFlags } from "../src/lib/testing/bufferTreeCompare";
import { getScenario, SCENARIOS } from "../scenarios/index";

interface CliFlags {
  name?: string;
  record: boolean;
  force: boolean;
  list: boolean;
  json: boolean;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { record: false, force: false, list: false, json: false };
  for (const arg of argv) {
    if (arg === "--record") flags.record = true;
    else if (arg === "--force") flags.force = true;
    else if (arg === "--list") flags.list = true;
    else if (arg === "--json") flags.json = true;
    else if (!arg.startsWith("-")) flags.name = arg;
  }
  return flags;
}

function baselinePath(scenarioName: string): string {
  return resolve("scenarios", "__baselines__", `${scenarioName}.json`);
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.list) {
    console.log("Available scenarios:");
    for (const name of Object.keys(SCENARIOS).sort()) {
      console.log(`  ${name}  — ${SCENARIOS[name].description}`);
    }
    return 0;
  }

  if (!flags.name) {
    console.error("usage: vite-node scripts/runScenario.ts <name> [--record [--force]] [--json] [--list]");
    return 2;
  }

  const test = getScenario(flags.name);
  console.log(`[scenario] ${test.name} — ${test.description}`);
  const totalTicks = test.steps.reduce((a, s) => a + s.ticks, 0);
  console.log(`[scenario] steps=${test.steps.length} total-ticks=${totalTicks} snapshot=${test.output.snapshot.length} buffers`);

  // Load existing baseline if present (so tests run against it on green-path runs).
  const path = baselinePath(test.name);
  if (existsSync(path) && !flags.record) {
    test.output.baseline = JSON.parse(readFileSync(path, "utf-8")) as BaselineFile;
  }

  const result = runBufferTest(test, { recordOnly: flags.record });

  if (flags.json) {
    console.log(JSON.stringify(result.captured, null, 2));
    return 0;
  }

  if (flags.record) {
    if (existsSync(path) && !flags.force) {
      console.error(`[scenario] baseline already exists at ${path}. Refuse to overwrite without --force.`);
      console.error(`[scenario] If you intend to update the baseline, re-run with: --record --force`);
      return 2;
    }
    const baseline = deriveBaselineFromCapture(test.name, result.captured);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
    console.log(`[scenario] recorded baseline at ${path}`);
    summarizeCapture(result.captured);
    console.log(`[scenario] finalSmState=${result.finalSmState} totalTicks=${result.totalTicks}`);
    return 0;
  }

  if (!test.output.baseline) {
    console.error(`[scenario] no baseline at ${path}`);
    console.error(`[scenario] run with --record to create one, then review the captures below before committing.`);
    summarizeCapture(result.captured);
    return 2;
  }

  if (result.flags.length === 0) {
    console.log(`[scenario] ✅ no flags vs ${path} (finalSmState=${result.finalSmState}, ticks=${result.totalTicks})`);
    return 0;
  }
  console.log(`[scenario] ⚠️ ${result.flags.length} flag(s) vs ${path} — review playback, decide regression vs improvement vs lateral`);
  console.log(formatFlags(result.flags));
  return 2;
}

function summarizeCapture(captured: Record<string, unknown>): void {
  console.log("[scenario] captured buffers:");
  for (const [bufId, data] of Object.entries(captured)) {
    const size = approximateJsonSize(data);
    console.log(`  ${bufId.padEnd(28)} ≈ ${size} bytes`);
  }
}

function approximateJsonSize(v: unknown): number {
  try { return JSON.stringify(v).length; } catch { return -1; }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("[scenario] fatal:", err);
  process.exit(2);
});
