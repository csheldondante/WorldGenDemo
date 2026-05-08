# `src/systems/` — feature-system rules

A system is a `SystemDescriptor` (see `src/runtime/system.ts`) with an `execute(ctx)` that mutates buffers based on declared `read`/`write`/`readwrite` access. Systems live here; they import from `src/buffers/` (for typed buffer ids and shapes) and call into pure modules in `src/map/`, `src/core/`, `src/terrain/`, `src/assets/`, or `src/render/`.

## Conventions

- **One file per system** (or one file per close-knit pair, like `input.ts` + `cameraMovement.ts` if they share an accumulator). `id` is camelCase ending in `System` — `cameraMovementSystem`, `loadSceneSystem`.
- **Export both** the `<NAME>_SYSTEM_ID` constant and a `create<Name>System()` factory. Other systems' `runsAfter` arrays import the ID, so it must be a stable string constant.
- **Buffer access declarations must be honest.** The graph hazard checker only enforces what you declare. Lying yields stale-read bugs that are hard to chase later.
- **Side-effect work** (DOM listeners, fetches) goes in a private accumulator/closure that the system drains per tick. See `attachInputListeners` + `createInputSystem` in `src/systems/input.ts` for the canonical pattern.

## Pipeline systems and `runOncePerRebuild`

Pipeline systems (those in `src/systems/pipeline/`) must run exactly once per rebuild generation. They use the helper in `src/systems/pipeline/common.ts`:

```ts
const state = { lastGen: -1 };
return {
  // ...
  execute: (ctx) => {
    runOncePerRebuild({ ctx, state, stageName: "myStage", body: (sm) => {
      // do work; sm.pendingRebuild has the payload, sm.rebuildGeneration is the current gen
    }});
  },
};
```

`runOncePerRebuild` reads `StateMachineBuffer`, returns early if state isn't `Rebuilding`, returns early if `rebuildGeneration` matches `state.lastGen`, otherwise runs the body and bumps the generation tracker. It also writes elapsed ms into `TimingBuffer.stages[stageName]` for HUD display.

## `runsAfter` conventions

If your system reads a buffer that another system in the same graph writes, you MUST `runsAfter` that writer. Same for write/write conflicts. The graph builder will validate this and throw at startup if you forgot.

A few canonical `runsAfter` chains worth knowing:

- Per-frame: `Input → CameraMovement → Render → Minimap → Hud`. `StateMachineSystem` runs first (no explicit `runsAfter`).
- Pipeline: `Parse → Split → Heightmap → JFA → TerrainMesh → AssetPlacement`, then `Render` and `Hud`.
- `HudSystem` reads `timing` (which many writers update). Its `runsAfter` includes the SM and every writer of `timing`. If you add a system that writes `timing`, add it to `HudSystem.runsAfter`.

Out-of-graph IDs in a `runsAfter` list are silently dropped — one descriptor works across all graphs the system participates in.

## Don't break

- `coreGraphs.test.ts` registers all real buffers + systems and asserts every graph validates. **If this test fails, the dev server boots to a black screen with no visible error.**
- Systems are sync. If you need async (a fetch, an async file read), hold the promise in a closure and check its state per tick — see `src/systems/loadScene.ts`.

@import ../../.claude/rules/registry.md
