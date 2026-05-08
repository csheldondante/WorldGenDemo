# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What this project is

Browser prototype: a labeled top-down PNG → a textured, populated 3D world you fly through. Each colour in `public/maps/<name>/map.png` is a semantic region; `scene.json` next to it maps colours to a fixed terrain vocabulary (`desert`, `tundra`, `forest`, `plains`, `canyon_wall`, `water`, `path`) and to procedural asset ids (`cactus`, `pine`, `boulder`, `shanty`, `bridge`).

The runtime is buffer/system/scheduler/state-machine architecture (see *Runtime in 30 seconds* below). The map → world transformation is a pipeline of pure functions wrapped as systems.

---

## Common commands

```bash
npm run dev          # vite dev server at http://127.0.0.1:5173
npm test             # vitest run (everything; ~134 tests)
npx vitest run path/to/test.ts          # run a single test file
npx vitest run --update                 # accept new baseline-snapshot output
npm run smoke        # headless boot smoke (see "Smoke harness" below)
npm run registry     # regenerate docs/REGISTRY.md from TS code
npm run gen-maps     # regenerate public/maps/*/map.png from scripts/genSampleMaps.ts
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

Use this before asking the user for a screenshot — it tells you exactly what the page sees. It caught the original silent boot failure (graph validation throw uncaught in `world.ts`) on the first run.

Notes: Playwright pulls ~120 MB of Chromium on first install. The script kills any leftover Vite holding port 5180 before starting (Windows uses `taskkill /T /F`). `smoke-out/` is gitignored.

---

## Runtime in 30 seconds

State machine boots `Startup → Loading → Rebuilding → Running`. Tab/mode events drive subsequent transitions (`Running + RebuildRequested → Rebuilding`, etc.).

Each tick:
1. Scheduler reads `StateMachineBuffer.activeGraph`.
2. Executes that graph in topo order via the registered systems.
3. Systems mutate buffers (which bump `version`).

Three graphs live in `src/app/graphs.ts`:
- **Loading**: `SM → Input → CameraMovement → LoadScene → Render → Hud`
- **Running**: `SM → Input → CameraMovement → Render → Minimap → Hud`
- **Rebuilding**: `SM → Parse → Split → Heightmap → JFA → TerrainMesh → AssetPlacement → Render → Hud`

Events: `LoadRequested { sceneName }`, `RebuildRequested { payload }`, `WorldReady`. The SM owns `pendingLoad` and `pendingRebuild` payloads across ticks (since the graph swap takes effect *next* tick).

---

## Layered architecture

```
src/app/        thin shell — wires runtime, exposes window.__runtimeDebug
src/systems/    feature systems (input, camera, render, minimap, hud, loadScene, pipeline/*)
src/buffers/    runtime buffers (input, camera, event, stateMachine, renderRefs, worldData, timing)
src/runtime/    Buffer, SystemDescriptor, ExecutionGraph, Scheduler, StateMachineSystem, registry, loop, dev
src/lib/        runtime-agnostic utilities — Dag<NodeId>, Fsm<S, E>, spatial/SpatialHash2D, testing/baseline
src/map/, src/core/, src/terrain/, src/assets/, src/render/
                pure transformation modules called by pipeline systems
                (parseBitmap, splitLayers, components, footprint, heightmap, jfa, terrainMesh, placeAssets, ...)
```

**Layer rules — enforced socially, not by tooling:**

- `src/lib/` is runtime-agnostic. It must not import from `src/runtime/`, `src/buffers/`, `src/systems/`, `src/app/`, or `three`.
- `src/runtime/` consumes `src/lib/`; defines the runtime model only. It does NOT know about specific buffers or features.
- `src/buffers/` and `src/systems/` are features expressed against the runtime. May import `three`.
- `src/app/` is a thin shell that builds the registry, validates graphs, and starts the loop.
- The pure pipeline modules (`src/map/*`, `src/core/*`) are the *implementation* the pipeline systems call. Their tests in `tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts` are the contract — never delete or weaken them during refactors.

---

## Registry workflow — do this every time you touch a buffer or system

The registry is the single searchable index of every buffer, system, and graph. The TS code in `src/buffers/index.ts` and `src/systems/index.ts` is the source of truth; `docs/REGISTRY.md` is a generated mirror.

Before adding a new `Buffer`, `SystemDescriptor`, or graph:

1. Run `npm run registry` to refresh `docs/REGISTRY.md`.
2. Search it for an existing entry that already covers your need. Prefer extending the existing one.
3. If you must add new:
   - Give it a clear `description` field — it renders in the doc.
   - Declare every buffer it reads or writes honestly. Hazards are validated at `buildExecutionGraph` time, but only if the declaration is accurate.
   - Add a test in `tests/buffers/` or `tests/systems/`.
4. Run `npm run registry` again so the doc reflects the new entry.

`tests/migration/coreGraphs.test.ts` registers all real buffers + systems + graphs and asserts validation passes. **It is the canary** — if you add a system with hazardous declarations or missing `runsAfter`, this test fails before the runtime ever boots. The original black-screen bug was a hazard that slipped past the smaller per-system tests; this catches them.

---

## TDD expectation

Every system, every buffer, every utility ships with tests. Drive systems with synthetic buffer state, not the real Three.js render path — Three.js coupling lives in `src/render/scene.ts` and `RenderSystem`; everything else should be testable headless.

For pure transformations (`parseBitmap`, `splitLayers`, etc.), prefer the **baseline-snapshot pattern** in `src/lib/testing/baseline.ts`:

```ts
import { expectBaselined, expectBaselinedApprox } from "../../src/lib/testing/baseline";
expectBaselined("parseBitmap.5x5", labelMap);     // exact match
expectBaselinedApprox("heightmap.5x5", hm.data, 4); // 4-decimal tolerance for FP
```

The serializer handles typed arrays, Maps, and Sets. Snapshots live at `tests/**/__snapshots__/*.snap` (committed). On intentional behavior changes, run `npx vitest run --update`.

---

## Dev vs prod error handling

`src/runtime/dev.ts` exports `IS_DEV` (from `import.meta.env.DEV`), `assertDev`, and `warnDev`.

- **Dev / vitest**: `assertDev` throws; the scheduler re-throws system errors so devtools / vitest catches the stack; `warnDev` logs to console.
- **Production**: `assertDev` logs and continues; the scheduler swallows system errors after writing to `TimingBuffer.warnings` (rendered by HUD).

The runtime FSM's `onUnhandled` callback wires to `warnDev` for unmatched + self-transition events — when you add a transition or wonder why an event "did nothing," the dev console tells you exactly what was rejected.

---

## Don't break

- The pre-runtime pure-function tests in `tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts`. They're the behavioral contract.
- `tests/migration/coreGraphs.test.ts` — keeps the runtime bootable.
- Functional parity for the canyon-desert and forest-clearing scenes during refactors. If a change would alter rendered output, run `npm run smoke` and inspect the screenshot before/after.
- The `src/lib/` layer rules — if you reach for `three` inside `src/lib/`, stop and put it in `src/render/` or a system.
