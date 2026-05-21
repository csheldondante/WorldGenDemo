# Unit tests / scenarios — MANDATORY reading

> **You MUST read this file in full before writing, modifying, or
> debugging ANY test. No exceptions.** This codebase has ONE testing
> framework. Bypassing it — even for a quick diagnostic — accumulates
> tech debt and silently breaks the regression-signal pipeline that
> every other discipline rule depends on.

## The ONE framework

There is exactly one regression-test framework in this codebase:

- **`runBufferTest`** (`src/app/bufferTest.ts`) — boots the real
  registry, registers real systems, runs the configured `BufferTest`
  step list, captures buffer snapshots at the end.
- **`BufferTest`** descriptor (`scenarios/*.ts`) — declares input
  (seed or recorded buffer state), the input system override (usually
  `createSimulatedInputSystem`), the step list (`tickSystems` or
  `tickActiveGraph`), and the output snapshot list.
- **Per-leaf comparator** (`src/lib/testing/bufferSnapshot.ts` +
  `bufferTreeCompare.ts`) — compares captured snapshot vs baseline JSON
  with per-path tolerance overrides and glob excludes.
- **`enableDebugBuffers` field** on `BufferTest` — opts the scenario
  into per-tick diagnostic capture by flipping a `<System>DebugBuffer`'s
  `enabled` flag before the first tick.
- **`runScenario.ts` CLI** + **`tests/scenarios/baselines.test.ts`** —
  the entry points that drive `runBufferTest` from the command line and
  from vitest, respectively.

That's it. Everything else is forbidden.

## ⛔ FORBIDDEN PATTERNS — every one of these is an instant violation

### 1. Hand-rolled per-tick trace scripts

```
❌ scripts/extendedScenario.ts:
   bootstrapApp(); buildExecutionGraph(); for (i in 600) { executeGraph(...); read buffers }

❌ Anything that calls `executeGraph` in a script's `for` loop and
   reads buffers in the loop body. That is a parallel framework, even
   if it's "just for diagnostic."
```

**Why it's bad**: bypasses the comparator. Bypasses the baseline.
Bypasses the per-leaf tolerance machinery. The data lives in the
script's stdout, not in a buffer the framework can capture and the
comparator can flag. Re-running the diagnostic later requires re-
running the script (and remembering you wrote one).

**What to do instead**: write a `BufferTest` scenario in
`scenarios/<name>.ts`. Use `enableDebugBuffers: ["<bufferId>"]` to
opt the per-tick capture in. Add the debug buffer id to
`output.snapshot` so the captured history is part of the snapshot.
Run with `npx vite-node scripts/runScenario.ts <name> --record` to
capture the initial baseline. Inspect via `--json` if you need to
read the captured values manually. The captured history is now a
regression artifact: future code changes that perturb those per-tick
values will flag in vitest.

### 2. `console.log` calls inside production system code

```
❌ src/systems/whatever.ts:
   console.log(`tick=${tick} body=${body}`);
```

**Why it's bad**: side channel that escapes git history, doesn't
appear in baselines, and floods stdout in CI.

**What to do instead**: write into a `<System>DebugBuffer`. Each tick
the system reads the buffer's `enabled` field cheaply; only writes a
row when true. Tests turn it on via `enableDebugBuffers`. Production
pays one bool read per tick. The captured history is comparable by
the framework. See `src/buffers/characterControllerDebug.ts` for the
canonical example.

### 3. Module-level globals for state capture

```
❌ src/systems/whatever.ts:
   export const MY_DEBUG = { history: [] as Row[] };
```

**Why it's bad**: hidden state. Doesn't reset between scenario runs.
Doesn't appear in buffer snapshots. Doesn't compose with the
framework's `byEntity` map semantics.

**What to do instead**: same as (2) — define a `<System>DebugBuffer`.

### 4. Reintroducing envelope/ranged-baseline testing

```
❌ baseline = { "vN": { min: -0.1, max: 0.1 } }
```

The previous `rangedBaseline` framework was deprecated on 2026-05-19
and removed. Envelope validation is strictly weaker than exact-with-
tolerance: a value can drift inside an envelope but still be a
regression. Don't re-introduce it.

**What to do instead**: the comparator already supports per-leaf
tolerance overrides with glob paths. Set `toleranceOverrides` on
the baseline JSON. See existing baselines for examples.

### 5. Promoting transient local variables to "real" runtime buffers
just to test them

```
❌ Adding `MyIntermediateBuffer` with a single field used only by the
   one system that owns it, just so a test can read it.
```

**Why it's bad**: spurious state. Production cost. Buffer schema
bloat.

**What to do instead**: define a `<System>DebugBuffer` with `enabled:
false` default. Production pays one bool check per tick; tests opt
in.

## ✅ CORRECT PATTERNS

### A. Adding a new scenario

1. Create `scenarios/<name>.ts` exporting a `BufferTest` const named
   `test`.
2. Add the import + entry in `scenarios/index.ts`.
3. Run `npx vite-node scripts/runScenario.ts <name> --record` to
   capture initial baseline.
4. Eyeball the captured output and EDIT the baseline JSON if needed
   (e.g., set tolerances on flaky-FP leaves). The baseline file is
   committed alongside the scenario.
5. Verify it runs in `tests/scenarios/baselines.test.ts`: `npx vitest
   run tests/scenarios/baselines.test.ts -t <name>`.

### B. Inspecting per-tick intermediate values (e.g., the controller's
internal aReqF, fwdMax, aFEff, gripBudget during a slide)

1. Find or define the system's `<System>DebugBuffer`. For
   `characterController` it's at
   `src/buffers/characterControllerDebug.ts`, capturing
   `ControllerDebugRow` per tick.
2. In the scenario file, add:
   ```ts
   enableDebugBuffers: ["characterControllerDebug"],
   output: { snapshot: [...GAMEPLAY_OUTPUT_BUFFERS, "characterControllerDebug"] },
   ```
3. Run with `--json` or look at the captured snapshot to inspect the
   `history` array. Use `restoreBufferData` if you need the
   deserialized Maps.

### C. Running scenarios with a different tick count for diagnostic

DO NOT write a custom runner script. Either:
- Create a NEW `BufferTest` scenario with the larger tick count.
  Record a baseline for it. It becomes a regression artifact.
- OR temporarily edit the existing scenario's `ticks` value, record a
  fresh baseline, run, REVERT the change. Discipline lets you peek;
  don't commit the changed tick count or the un-vetted baseline.

### D. Running the full suite

```
npx vitest run                              # everything
npx vitest run tests/scenarios              # scenario baselines only
npx vitest run -t <scenario-name>           # one scenario
npx vite-node scripts/runScenario.ts <name> # CLI runner, --record / --json available
```

## When you're tempted to bypass the framework

You aren't. Stop. Re-read the FORBIDDEN PATTERNS section. The
framework already covers what you want to do, even if it requires 30
seconds more boilerplate than a shell script. The boilerplate
discipline is what keeps regressions catchable; the shell script is
what lets them through.

If you genuinely believe the framework cannot capture what you need,
**STOP AND ASK THE USER**. Do not invent a parallel mechanism. The
framework can be extended (e.g., new buffer types, new
`<System>DebugBuffer` per system) with the user's sign-off; it cannot
be silently bypassed.

## Specific things I (Claude) have done wrong before — DO NOT REPEAT

1. **`scripts/climbTrace.ts` (2026-05-20)** — hand-rolled per-tick
   trace via `executeGraph` in a `for` loop. Bypassed the framework.
   Deleted in the 2026-05-20 reset.

2. **`scripts/extendedScenario.ts` (2026-05-21)** — same violation,
   rewritten because I forgot the rule. Deleted 2026-05-21 with this
   document.

3. **Misclassifying scenario diffs as "lateral" without checking the
   `transitions` field** (2026-05-21) — covered by CLAUDE.md's pre-
   flight gate; relisted here because it's a related "trust the
   framework's output completely" lapse.

## TL;DR

> The framework is in `src/app/bufferTest.ts` + `scenarios/*.ts` +
> `tests/scenarios/baselines.test.ts`. **Use it.** If your work
> involves running systems for some number of ticks and inspecting
> buffer state — even just to look at values — that's a scenario.
> Don't write a script.
