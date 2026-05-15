# Codebase index — start here

A single page mapping "I want to learn / change X" → "read these files first."

> If you're a new agent in this codebase, read this page, then the root `CLAUDE.md`, then whichever subsystem doc the user's task points to.

---

## Working on…

### …the runtime (buffers, systems, scheduler, FSM)
1. `CLAUDE.md` (root) — runtime in 30 seconds; layer rules
2. `src/runtime/CLAUDE.md` — buffer/system contracts, hazard rules, dev-loud errors, FSM patterns
3. `.claude/rules/coding_practices.md` — data-oriented design defaults

### …adding a new buffer, system, or graph
1. `.claude/rules/registry.md` — workflow (run `npm run registry`, search, then add)
2. `src/buffers/CLAUDE.md` *or* `src/systems/CLAUDE.md` — naming + conventions
3. `docs/REGISTRY.md` — generated index of every existing buffer/system/graph

### …the bitmap → 3D pipeline
1. `docs/PIPELINE.md` — stage-by-stage walkthrough
2. `src/map/` — pure transformations
3. `src/systems/pipeline/` — runtime wrappers using `runOncePerRebuild`
4. `tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts` — behavioral contract

### …character physics, controllers, surfaces, force fields
1. `docs/character-controller.md` — end-to-end per-tick pipeline (systems, buffers, FSM, profile table, current leave-surface conditions, known gaps)
2. `docs/PHYSICS.md` — the surface-frame solver, why it's shaped this way, and how to extend it (orientation, moving platforms, ragdoll, flying)
3. `src/world/CLAUDE.md` — surface/volume model layer rules
4. `src/world/surfaceProvider.ts` — `SurfaceProvider` interface + `HeightmapSurfaceProvider`
5. `src/systems/characterController.ts` — the solver
6. `src/buffers/characterControllerProfile.ts` — directional accel caps + state thresholds
7. `tests/systems/characterController.test.ts` — flat / slope / brake / icySlide / detach / ragdoll / jump

### …the editor (paint maps, palette, send-to-world)
1. `src/buffers/builder.ts` — buffer shape (palette, history, brush state)
2. `src/systems/builder.ts` + `src/systems/builderInput.ts` — DOM events + state mutation
3. `src/builder/` — pure logic (flood fill, scene-from-palette, history stack, defaults)
4. `tests/builder/`, `tests/systems/builder.test.ts` — coverage

### …rendering, shaders, three.js
1. `src/render/scene.ts` — Three.js scene wiring
2. `src/render/splatShader.ts` — terrain texture splatting
3. `src/render/thumbnailRenderer.ts` — offscreen renders for the editor's asset palette
4. `src/systems/render.ts` — per-frame draw call

### …assets and procedural geometry
1. `src/assets/catalog.ts` + `src/assets/register.ts` — id → procedural builder
2. `src/assets/procedural<Foo>.ts` — one file per asset id
3. `src/map/placeAssets.ts` + `src/map/components.ts` + `src/map/footprint.ts` — placement logic

### …terrain types and textures
1. `src/terrain/catalog.ts` — terrain id list
2. `src/terrain/textures.ts` — `buildProceduralTextures()` for the splat shader

### …debugging the running app
1. `npm run smoke` — captures `smoke-out/{console.log, network.log, page.png, state.json}`
2. `window.__runtimeDebug()` in the browser console — same snapshot live
3. `tests/CLAUDE.md` — testing conventions; baseline-snapshot pattern; **`tests/migration/coreGraphs.test.ts` is the canary — if it fails, the dev server boots black**

### …the runtime-agnostic shared lib
1. `src/lib/CLAUDE.md` — must-not-import constraint; spatial-index conventions
2. `src/lib/{Dag, Fsm}.ts` — generic graph and state-machine utilities
3. `src/lib/spatial/SpatialHash2D.ts` — broadphase candidate for sphere-vs-prop collisions
4. `src/lib/testing/baseline.ts` — baseline-snapshot harness

---

## Top-level structure

```
src/app/        thin shell — wires runtime, exposes window.__runtimeDebug
src/systems/    feature systems (input, camera, render, minimap, hud, loadScene, pipeline/*, character physics)
src/buffers/    runtime buffers (input, camera, event, stateMachine, renderRefs, worldData, timing, character physics)
src/runtime/    Buffer, SystemDescriptor, ExecutionGraph, Scheduler, StateMachineSystem, registry, loop, dev
src/lib/        runtime-agnostic utilities — Dag, Fsm, spatial/SpatialHash2D, testing/baseline
src/map/, src/core/, src/terrain/, src/assets/, src/render/
                pure transformation modules called by pipeline systems
src/world/      surfaces, volumes, force fields (the world model)
src/builder/    pure editor logic
docs/           PIPELINE.md, PHYSICS.md, INDEX.md (this file), REGISTRY.md (generated)
tests/          pure-function contract, runtime, systems, baseline snapshots, migration canaries
.claude/rules/  coding_practices.md, registry.md (cross-cutting)
```

Each folder gets its own `CLAUDE.md` when there are folder-specific rules; cross-cutting rules live in `.claude/rules/` and are imported via `@import` from root `CLAUDE.md` and the relevant subfolder docs.

## Don't break

Per the root `CLAUDE.md`:
- The pre-runtime pure-function tests (`tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts`).
- `tests/migration/coreGraphs.test.ts` — the boot canary.
- Functional parity for canyon-desert and forest-clearing scenes during refactors.
- The `src/lib/` layer rules — runtime-agnostic, no `three`.
