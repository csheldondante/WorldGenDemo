import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runBufferTest, type BaselineFile } from "../../src/app/bufferTest";
import { formatFlags } from "../../src/lib/testing/bufferTreeCompare";
import { SCENARIOS } from "../../scenarios/index";

/**
 * Scenario-baseline regression suite. For every entry in `SCENARIOS`, loads
 * `scenarios/__baselines__/<name>.json`, runs the test with the full real
 * runtime via `runBufferTest`, and asserts no flags. Any diff against the
 * baseline is a test failure.
 *
 * If a flag fires here:
 *   1. Inspect the failure. The flag path + (baseline, actual, tolerance)
 *      triple tells you what drifted.
 *   2. Classify the change as improvement / lateral / regression. Trace the
 *      mechanism to a line of code — see `CLAUDE.md > MANDATORY change
 *      discipline > After every batch of edits`.
 *   3. Get the user to sign off on the classification. Then re-record the
 *      baseline via `npx vite-node scripts/runScenario.ts <name> --record --force`.
 *
 * Do not blindly accept a new baseline. The whole point of this suite is to
 * make baseline drift visible — auto-accepting is the most common source of
 * silent regressions in this codebase.
 *
 * A missing baseline is itself a failure: you cannot tell whether the
 * scenario's output drifted if there is nothing to compare against. Record
 * the baseline (`--record` first time, `--record --force` to overwrite) and
 * commit the JSON alongside the scenario module.
 */

function baselinePath(name: string): string {
  return resolve(process.cwd(), "scenarios", "__baselines__", `${name}.json`);
}

describe("scenario baselines", () => {
  for (const [name, test] of Object.entries(SCENARIOS)) {
    it(name, () => {
      const path = baselinePath(name);
      if (!existsSync(path)) {
        throw new Error(
          `no baseline at ${path}. Record one with:\n` +
            `  npx vite-node scripts/runScenario.ts ${name} --record\n` +
            `then commit the JSON alongside the scenario module.`,
        );
      }
      // Mutate `test.output.baseline` the same way the CLI runner does — the
      // scenario module deliberately leaves it unset so the harness can load
      // from disk at run-time without bundling JSON into the TS source.
      test.output.baseline = JSON.parse(readFileSync(path, "utf-8")) as BaselineFile;

      const result = runBufferTest(test);

      if (result.flags.length > 0) {
        // Format every flag — the failure message IS the diff.
        const formatted = formatFlags(result.flags);
        throw new Error(
          `scenario "${name}" produced ${result.flags.length} flag(s) vs ${path}:\n${formatted}\n\n` +
            `Read CLAUDE.md > "MANDATORY change discipline" before re-recording the baseline.`,
        );
      }
      expect(result.flags).toEqual([]);
    });
  }
});
