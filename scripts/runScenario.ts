/**
 * Scenario CLI runner — bootstraps the REAL runtime (via `bootstrapApp`) with
 * the scenario's chosen input source, runs `scenario.seed(reg)` to populate
 * synthetic state, then ticks the production graph (`reg.getGraph(sm.activeGraph)`)
 * for `durationTicks` frames, sampling channels each tick.
 *
 *   npx vite-node scripts/runScenario.ts <name>            # run + diff vs baseline
 *   npx vite-node scripts/runScenario.ts <name> --record   # record fresh baseline
 *   npx vite-node scripts/runScenario.ts <name> --json     # dump captured channels
 *   npx vite-node scripts/runScenario.ts --list            # list available scenarios
 *
 * Exit code 0 = no regressions, 1 = regression(s) found, 2 = harness error.
 *
 * Baselines live in `scenarios/__baselines__/<name>.json`. A baseline is
 * gated: re-running `--record` over an existing baseline is refused unless
 * `--force` is also passed.
 */
import { resolve, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { bootstrapApp } from "../src/app/bootstrap";
import { runScenarioHeadless, deriveBaseline } from "../src/lib/testing/scenarioHarness";
import { compareRangedBaseline, formatRegressions, type RangedBaseline } from "../src/lib/testing/rangedBaseline";
import { getScenario, SCENARIOS } from "../scenarios/index";
import type { ScenarioDescriptor } from "../src/lib/testing/scenarioHarness";
import { createInputPlaybackSystem, type InputRecording } from "../src/systems/testing/inputPlayback";
import { createSimulatedInputSystem, type SimulatedInputGenerator } from "../src/systems/testing/simulatedInput";
import type { SystemDescriptor } from "../src/runtime/system";

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

/**
 * Translate a scenario's `inputSource` into a SystemDescriptor with the
 * canonical `INPUT_SYSTEM_ID`. The runner passes this to `bootstrapApp` so the
 * scenario sees the production input pipeline (mapper → characterInput →
 * controllers) with scripted input on top.
 */
function buildInputSystem(scenario: ScenarioDescriptor): SystemDescriptor {
  const src = scenario.inputSource;
  if (src.kind === "playback") return createInputPlaybackSystem(src.recording as InputRecording);
  if (src.kind === "simulated") return createSimulatedInputSystem(src.generator as SimulatedInputGenerator);
  // Make TS check exhaustiveness if we add a kind without handling it.
  const _exhaustive: never = src;
  void _exhaustive;
  throw new Error(`unknown scenario input source`);
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

  const scenario = getScenario(flags.name);
  console.log(`[scenario] ${scenario.name} — ${scenario.description}`);
  console.log(`[scenario] ticks=${scenario.durationTicks} dt=${(scenario.dt ?? 1 / 60).toFixed(5)}s channels=${scenario.channels.length} input=${scenario.inputSource.kind}`);

  // Bootstrap the REAL runtime with the scenario's input source. sceneName=null
  // means no LoadRequested event — the seed function is responsible for
  // putting the SM into the desired state (typically forcing Running) and
  // populating synthetic buffers.
  const inputSystem = buildInputSystem(scenario);
  const app = bootstrapApp({ inputSystem, sceneName: null });
  const { entityIds } = scenario.seed(app.registry);
  const result = runScenarioHeadless(app.registry, scenario, entityIds);

  if (flags.json) {
    console.log(JSON.stringify(result.channels, null, 2));
    return 0;
  }

  const path = baselinePath(scenario.name);
  if (flags.record) {
    if (existsSync(path) && !flags.force) {
      console.error(`[scenario] baseline already exists at ${path}. Refuse to overwrite without --force.`);
      console.error(`[scenario] If you intend to update the baseline, re-run with: --record --force`);
      return 2;
    }
    const baseline = deriveBaseline(scenario, result);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
    console.log(`[scenario] recorded baseline at ${path}`);
    console.log(`[scenario] finalSmState=${result.finalSmState}`);
    summarizeChannels(result.channels);
    return 0;
  }

  if (!existsSync(path)) {
    console.error(`[scenario] no baseline at ${path}`);
    console.error(`[scenario] run with --record to create one, then review the channels below before committing.`);
    summarizeChannels(result.channels);
    return 2;
  }

  const baseline = JSON.parse(readFileSync(path, "utf-8")) as RangedBaseline;
  const regs = compareRangedBaseline(baseline, result.channels);
  if (regs.length === 0) {
    console.log(`[scenario] ✅ no regressions vs ${path} (finalSmState=${result.finalSmState})`);
    return 0;
  }
  console.log(`[scenario] ❌ regressions vs ${path}`);
  console.log(formatRegressions(regs));
  return 1;
}

function summarizeChannels(channels: Record<string, number[] | string[]>): void {
  console.log("[scenario] channel summary:");
  for (const [name, data] of Object.entries(channels)) {
    if (typeof data[0] === "number") {
      const nums = data as number[];
      let min = Infinity, max = -Infinity, sum = 0;
      for (const v of nums) { if (v < min) min = v; if (v > max) max = v; sum += v; }
      const mean = sum / nums.length;
      const first = nums[0];
      const last = nums[nums.length - 1];
      console.log(`  ${name.padEnd(18)} n=${nums.length} first=${first.toFixed(3)} last=${last.toFixed(3)} min=${min.toFixed(3)} max=${max.toFixed(3)} mean=${mean.toFixed(3)}`);
    } else {
      const strs = data as string[];
      const counts = new Map<string, number>();
      for (const s of strs) counts.set(s, (counts.get(s) ?? 0) + 1);
      const summary = Array.from(counts.entries()).map(([k, v]) => `${k}×${v}`).join(", ");
      console.log(`  ${name.padEnd(18)} n=${strs.length} { ${summary} }`);
    }
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("[scenario] fatal:", err);
  process.exit(2);
});
