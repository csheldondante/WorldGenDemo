# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## What this is

Browser prototype: a labeled top-down PNG → a textured, populated 3D world you fly through. Each colour in `public/maps/<name>/map.png` is a semantic region; `scene.json` next to it maps colours to a fixed terrain vocabulary (`desert`, `tundra`, `forest`, `plains`, `canyon_wall`, `water`, `path`) and to procedural asset ids (`cactus`, `pine`, `boulder`, `shanty`, `bridge`).

The runtime is buffer/system/scheduler/state-machine architecture; the map → world transformation is a pipeline of pure functions wrapped as systems.

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

- `.claude/rules/registry.md` — how to add a new buffer, system, or graph (applies whether the work is in `src/buffers/`, `src/systems/`, or `src/app/graphs.ts`)

---

## Don't break

- The pre-runtime pure-function tests in `tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts` — behavioral contract.
- `tests/migration/coreGraphs.test.ts` — keeps the runtime bootable. If this fails, the dev server boots to a black screen with no error.
- Functional parity for the canyon-desert and forest-clearing scenes during refactors. If a change would alter rendered output, run `npm run smoke` and inspect the screenshot before/after.
- The `src/lib/` layer rules — if you reach for `three` inside `src/lib/`, stop and put it in `src/render/` or a system.
