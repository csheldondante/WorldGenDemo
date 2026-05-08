# `tests/` — testing rules

## TDD bar

Every system, every buffer, every utility ships with tests. Drive systems with synthetic buffer state, not the real Three.js render path — Three.js coupling lives in `src/render/scene.ts` and `RenderSystem`; everything else should be testable headless.

For pipeline stages, build a small registry inline in the test, register only the systems involved, build a graph from those nodes, and call `executeGraph`. See `tests/migration/rebuildPipeline.test.ts` for the canonical pattern.

## Baseline-snapshot pattern

For pure transformations (`parseBitmap`, `splitLayers`, `floodFill`, `sceneFromPalette`, etc.), prefer the snapshot pattern in `src/lib/testing/baseline.ts`:

```ts
import { expectBaselined, expectBaselinedApprox } from "../../src/lib/testing/baseline";

expectBaselined("parseBitmap.5x5", labelMap);            // exact match
expectBaselinedApprox("heightmap.5x5", hm.data, 4);      // 4-decimal tolerance for FP
```

The serializer handles typed arrays, `Map`, `Set`, and rounds floats to a configurable precision. Snapshots live at `tests/**/__snapshots__/*.snap` and are committed.

On intentional behavior changes, run `npx vitest run --update`. Review the diff before committing — the snapshot file IS the regression detector.

## The canary: `tests/migration/coreGraphs.test.ts`

This test registers all real buffers, systems, and graphs and asserts every graph validates without throwing. **If it fails, the dev server boots to a black screen with no visible error** — the original silent-validation bug that bit us before the smoke harness existed.

If you add a system or buffer, this test must stay green. Local fix: add the right `runsAfter` until the hazard checker stops complaining.

## Smoke harness — `npm run smoke`

Boots Vite + headless Chromium, captures `console.log`, `network.log`, `page.png`, `state.json` to `smoke-out/`. Use this:

- After adding a new mode/graph, to confirm the runtime actually boots end-to-end (not just that the unit tests pass).
- Before opening a PR that touches the boot path.
- Whenever the user reports something visual that isn't reproducing in tests.

`smoke-out/state.json` includes `{ smState, activeGraph, terrainMeshSet, assetMeshCount, stages, warnings }` — read it directly to know what the page actually saw without asking the user for a screenshot.

## Where tests live

- `tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts` — pre-runtime pure-function contract. **Behavioral promise; never weaken or delete.**
- `tests/lib/**` — generic utilities (DAG, FSM, spatial indexes).
- `tests/runtime/**` — runtime primitives (buffer, registry, graph, scheduler, stateMachine).
- `tests/systems/**` — feature systems with synthetic buffer state.
- `tests/migration/**` — integration: input → camera → render, rebuild pipeline, mode swap, hazard enforcement, **coreGraphs canary**.
- `tests/baseline/**` — snapshot regression tests for pure transformations.
- `tests/builder/**` — builder-specific pure logic (flood fill, palette → scene.json, history stack).
