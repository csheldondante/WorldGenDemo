# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What this is

Browser prototype: a labeled top-down PNG → a textured, populated 3D world you fly through. Each colour in `public/maps/<name>/map.png` is a semantic region; `scene.json` next to it maps colours to a fixed terrain vocabulary (`desert`, `tundra`, `forest`, `plains`, `canyon_wall`, `water`, `path`) and to procedural asset ids (`cactus`, `pine`, `boulder`, `shanty`, `bridge`).

The runtime is buffer/system/scheduler/state-machine architecture; the map → world transformation is a pipeline of pure functions wrapped as systems.

> **First-time orientation:** read [`docs/INDEX.md`](docs/INDEX.md) — a topic-keyed map of "I'm working on X → read these files."

---

## Common commands

```bash
npm run dev          # vite dev server at http://127.0.0.1:5173
npm test             # vitest run (everything)
npx vitest run path/to/test.ts          # run a single test file
npx vitest run --update                 # accept new baseline-snapshot output
npm run smoke        # headless boot smoke (Playwright). See "Smoke harness" below
npm run registry     # regenerate docs/REGISTRY.md from TS code
npm run gen-maps     # regenerate public/maps/*/map.png
npx tsc --noEmit     # type check
npx vite build       # production bundle
```

`?map=forest-clearing` (or any other folder name in `public/maps/`) switches scenes without code changes.

---

## Smoke harness — primary debugging tool

`npm run smoke` boots Vite + headless Chromium, waits ~4 s, and writes:

- `smoke-out/console.log` — every `console.*`, `pageerror`, `requestfailed`
- `smoke-out/network.log` — every HTTP response with status code
- `smoke-out/page.png` — full-page screenshot
- `smoke-out/state.json` — `window.__runtimeDebug()` snapshot (SM state, active graph, pipeline flags, stage timings, buffer versions, full graph orderings)

Use this before asking the user for a screenshot — it tells you exactly what the page sees.

---

## Runtime in 30 seconds

State machine boots `Startup → Loading → Rebuilding → Running`. Tab/mode events drive subsequent transitions (`Running + RebuildRequested → Rebuilding`, etc.).

Each tick:
1. Scheduler reads `StateMachineBuffer.activeGraph`.
2. Executes that graph in topo order.
3. Systems mutate buffers (which bump `version`).

Three graphs live in `src/app/graphs.ts`:
- **Loading**: `SM → Input → CameraMovement → LoadScene → Render → Hud`
- **Running**: `SM → Input → CameraMovement → Render → Minimap → Hud`
- **Rebuilding**: `SM → Parse → Split → Heightmap → JFA → TerrainMesh → AssetPlacement → Render → Hud`

Events: `LoadRequested { sceneName }`, `RebuildRequested { payload }`, `WorldReady`. The SM owns `pendingLoad` and `pendingRebuild` payloads across ticks.

---

## Layered architecture

```
src/app/        thin shell — wires runtime, exposes window.__runtimeDebug
src/systems/    feature systems (input, camera, render, minimap, hud, loadScene, pipeline/*)
src/buffers/    runtime buffers (input, camera, event, stateMachine, renderRefs, worldData, timing)
src/runtime/    Buffer, SystemDescriptor, ExecutionGraph, Scheduler, StateMachineSystem, registry, loop, dev
src/lib/        runtime-agnostic utilities — Dag, Fsm, spatial/SpatialHash2D, testing/baseline
src/map/, src/core/, src/terrain/, src/assets/, src/render/
                pure transformation modules called by pipeline systems
```

**Layer rules — enforced socially, not by tooling:**

- `src/lib/` is runtime-agnostic. It must not import from `src/runtime/`, `src/buffers/`, `src/systems/`, `src/app/`, or `three`.
- `src/runtime/` consumes `src/lib/`; defines the runtime model only. Does NOT know about specific buffers or features.
- `src/buffers/` and `src/systems/` are features expressed against the runtime. May import `three`.
- `src/app/` is a thin shell.
- The pure pipeline modules (`src/map/*`, `src/core/*`) are the *implementation* the pipeline systems call. Their tests in `tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts` are the contract — never delete or weaken them during refactors.

---

## Where the topic-specific rules live

Per-directory `CLAUDE.md` files auto-load when working in that subtree. Read the relevant one before significant work; update it when invariants change.

- `src/runtime/CLAUDE.md` — buffer/system contracts, hazard rules, dev-vs-prod error handling, FSM patterns
- `src/systems/CLAUDE.md` — `SystemDescriptor` shape, `runOncePerRebuild` idiom, `runsAfter` conventions
- `src/buffers/CLAUDE.md` — naming, version semantics, when to add a new buffer
- `src/lib/CLAUDE.md` — runtime-agnostic constraint, spatial-index conventions
- `tests/CLAUDE.md` — TDD bar, baseline-snapshot pattern, smoke harness, `coreGraphs` canary

Cross-cutting rules (apply across non-nested folders) live in `.claude/rules/`:

- `.claude/rules/coding_practices.md` — data-oriented design, FSM/spatial-index reuse, separate-compute-from-rendering, dev-loud error handling. **Read this before writing systems.**
- `.claude/rules/registry.md` — how to add a new buffer, system, or graph (applies whether the work is in `src/buffers/`, `src/systems/`, or `src/app/graphs.ts`)

@import .claude/rules/coding_practices.md

---

## Don't break

- The pre-runtime pure-function tests in `tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts` — behavioral contract.
- `tests/migration/coreGraphs.test.ts` — keeps the runtime bootable. If this fails, the dev server boots to a black screen with no error.
- Functional parity for the canyon-desert and forest-clearing scenes during refactors. If a change would alter rendered output, run `npm run smoke` and inspect the screenshot before/after.
- The `src/lib/` layer rules — if you reach for `three` inside `src/lib/`, stop and put it in `src/render/` or a system.

---

## MANDATORY: change discipline — baselines, diffs, justification

This codebase has buffer-snapshot scenario baselines (`scenarios/__baselines__/*.json`) and ranged-baseline trajectory tests (`tests/systems/characterController.trajectory.test.ts`) for exactly one reason: **every change in computed quantity must be visible, explainable, and justified before you call a fix done.** The framework lets you flag changes pre-commit. Skipping it produces silent regressions and tech debt that compound.

**The scenario suite is wired into vitest at `tests/scenarios/baselines.test.ts`.** Every `npm test` run loads every baseline, runs every scenario via `runBufferTest`, and asserts zero flags. A baseline diff fails the test — there is no longer any way to silently ignore it. Treat it the same as a failing unit test.

### Before every batch of edits

1. **Identify which baselines / scenarios will be touched.** If you can't list them, you don't understand the change's scope.
2. **Run them.** `npx vitest run tests/scenarios/baselines.test.ts` covers all scenarios; add the relevant `tests/systems/*.test.ts` for system-level diagnostic tests.
3. **Capture the pre-state.** Either by running once and copying the JSON snapshots aside, or noting the failing-test output (which IS the diff against baseline).

### After every batch of edits — what to do when scenario baselines fail

1. **Re-run the suite.** `npx vitest run tests/scenarios/baselines.test.ts`. Any flagged scenario is a behavior change that needs explaining.
2. **For EVERY diff against baseline, write up:**
   - **Classification**: **lateral** (different but equivalent), **regression** (worse), or **improvement** (better).
   - **Mechanism**: WHY did your change cause this specific diff? Trace it to a line of code. "Probably from..." is not acceptable. If you can't explain it, you don't understand what your change does — go investigate.
   - **Per-quantity**: every changed value gets its own line. `vy increased by 0.3 at frame 104 BECAUSE the new gripBudget formula raised fwdMax from 9.81 to 14.81 m/s², and the controller used the extra headroom to push tangent harder, which the rescale step propagated into vy.`
3. **If you can't confidently classify a diff, surface it to the user.** Show the flag (path, baseline value, actual value, your candidate mechanism), say "I'm not sure whether this is improvement / lateral / regression," and ask them to look at the test + data with you. Do NOT guess.
4. **Get the user's sign-off on the classifications.** Lateral changes still need sign-off because the user knows feel-implications the snapshot doesn't capture. Improvements still need sign-off so the user can confirm you understand WHY it's an improvement.
5. **Only after sign-off, re-record the baseline.** `npx vite-node scripts/runScenario.ts <name> --record --force` for one scenario, or loop over all changed scenarios. Commit the new baseline JSON in the same commit as the code change that caused the diff, with the classification + mechanism in the commit message.
6. **DO NOT** run `vitest run --update` to accept new snapshots without that writeup. Auto-accepting is the most common source of silent regressions in this codebase.

### Investigative changes

When debugging, instrument with the per-tick diagnostic pattern (see `CONTROLLER_DEBUG` in `src/systems/characterController.ts` for the canonical example): capture every computed quantity (grip budgets, applied accels, surface reactions, centripetal terms) and dump them per frame. **Diagnose by reading data, not by theorizing.** If you find yourself writing "this might be because..." without backing data, stop and instrument first.

### Principled vs hacky — the test

A change is **principled** when it:
- Fixes a clearly identified root cause (proven via instrumentation + data).
- Has its diff against scenario baselines explained for every changed quantity.
- Doesn't add fields, branches, or special cases that duplicate existing data-oriented structure (per `.claude/rules/coding_practices.md`).
- Either updates the baselines deliberately (with user sign-off) or leaves them unchanged.

A change is **hacky / tech debt** when it:
- "Probably fixes it" without trace verification.
- Adds a field or branch to paper over a deeper inconsistency.
- Sets a value to 0 or special-cases a state to make a test pass without explaining the physical meaning.
- Avoids running the scenario harness because "it'll probably break and that's expected."
- Bundles multiple changes so the diff is hard to attribute.

**Default to principled.** Surface the choice explicitly when you can't.

### Memory of past failures (2026-05-19)

I (Claude) repeatedly failed this discipline during the climb / heightmap-stutter batch — kept theorizing about energy-conservation rescale, normal smoothing, smoothstep blending without ever running the scenario harness or instrumenting accel components. Each "fix" landed without confirming what it actually changed in the buffer state. The user had to redirect me to actual data inspection multiple times. **Don't repeat this.**

### MANDATORY: use the buffer-snapshot framework. Do not bypass it.

There is **one** regression-test framework in this codebase: the buffer-snapshot comparator in `src/app/bufferTest.ts` + `src/lib/testing/bufferSnapshot.ts` + `src/lib/testing/bufferTreeCompare.ts`. Scenarios in `scenarios/*.ts` describe a seed + system list + tick count + output buffer ids, and a baseline JSON in `scenarios/__baselines__/<name>.json` is the regression signal. The comparator handles `Map<EntityId, T>`, nested objects, typed arrays, and per-leaf tolerance overrides with glob paths.

A previous parallel framework (`src/lib/testing/rangedBaseline.ts` + `src/lib/testing/scenarioHarness.ts`) used `[min, max]` envelopes per channel. **It was deprecated on 2026-05-19 and removed.** Envelope validation is strictly weaker than exact-with-tolerance: a value can drift inside an envelope but still represent a regression. Performance also matters — the buffer-snapshot path is faster and the tests run frequently. Do NOT reintroduce a parallel framework.

#### How to debug intermediate values

When you need to inspect quantities that aren't in a buffer (e.g. local variables inside a system's `execute` callback):

✅ **DO**: define a `<System>DebugBuffer` (see `src/buffers/characterControllerDebug.ts` for the canonical example). It has a top-level `enabled: boolean` field that defaults to false, plus a `byEntity: Map<EntityId, { history: Row[] }>` accumulator. The system reads `enabled` cheaply each tick and only writes when true. Tests turn it on via `BufferTest.enableDebugBuffers: ["<bufferId>"]` and add the same id to `output.snapshot` so the baseline captures the full per-tick history.

❌ **DO NOT**:
- Add module-level globals like `export const MY_DEBUG = { enabled, log: [] }` — they bypass the framework, escape git history, and don't appear in baselines.
- Add `console.log` calls inside production system code.
- Build hand-rolled per-tick trace tests that read buffers in a custom loop — that's a parallel framework, even if small.
- Reintroduce envelope-based testing (`[min, max]` per channel). Exact-with-tolerance via the comparator covers the same use case more strictly.
- Promote local variables to "real" runtime buffers JUST to test them. That's spurious state. Use a debug buffer with `enabled: false` default instead — the production cost is one bool read per tick.

#### When to add a new debug buffer

A new `<System>DebugBuffer` belongs in `src/buffers/<systemName>Debug.ts` when:

- The system has multiple per-tick intermediate values (≥3) that are diagnostically valuable but not consumed by any downstream system.
- You'd otherwise be tempted to add `console.log`s or a module-level debug array.
- You want regression tests that flag changes in those intermediates as part of normal scenario runs.

Register it in `src/buffers/index.ts`. Declare `readwrite` access on it in the system's descriptor. Gate the write on the buffer's `enabled` field. The `history: Row[]` accumulator pattern captures per-tick trajectories; the buffer-snapshot comparator handles them natively.

If the framework can't capture what you need, **extend the framework** (with user sign-off) — do not add a side channel.
