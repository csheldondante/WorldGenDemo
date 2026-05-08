# WorldGenDemo — agent guidance

This file is loaded automatically by Claude Code into every conversation in
this repo. Read it before doing significant work; update it when invariants
change.

---

## Architecture in one screen

```
┌─────────────────────────────────────────────┐
│ src/app/        thin shell — wires runtime  │
├─────────────────────────────────────────────┤
│ src/systems/    feature systems             │
│ src/buffers/    runtime buffers             │
├─────────────────────────────────────────────┤
│ src/runtime/    scheduler, registry, graph  │
│                 (consumes lib/dag, lib/fsm) │
├─────────────────────────────────────────────┤
│ src/lib/        shared, generic utilities:  │
│   dag.ts        Dag<NodeId>                 │
│   stateMachine.ts  Fsm<S, E>                │
│   spatial/      spatial indexes             │
└─────────────────────────────────────────────┘
```

Layer rules — **enforced socially, not by tooling, so respect them**:

- `src/lib/` — runtime-agnostic. **Must not import** from `src/runtime/`,
  `src/buffers/`, `src/systems/`, `src/app/`, or `three`. Pure data structures
  + algorithms with their own tests.
- `src/runtime/` — consumes `src/lib/`. Defines the runtime model
  (`Buffer<T>`, `SystemDescriptor`, `ExecutionGraph`, `Scheduler`,
  `StateMachineSystem`). Does NOT know about specific buffers or features.
- `src/buffers/` and `src/systems/` — features of this prototype expressed
  against the runtime. Free to import from `three` and from the other
  feature modules they need.
- `src/app/` — thin shell that builds the registry, validates graphs, and
  starts the loop.

Pre-existing pure modules (`src/core/`, `src/map/parseBitmap.ts`,
`src/map/splitLayers.ts`, `src/map/components.ts`, `src/map/footprint.ts`,
`src/map/heightmap.ts`, `src/map/jfa.ts`, etc.) stay as the *implementation*
that pipeline systems call. Those modules' tests (in `tests/`) are
authoritative for behavior — never delete or weaken them during refactors.

---

## Registry workflow — **do this every time you touch a buffer or system**

The registry is the single searchable index of every buffer, system, and
graph in the runtime. Future agents (and you) reuse what already exists by
searching it; redundant additions get caught here. The TS code is the source
of truth; `docs/REGISTRY.md` is a generated mirror.

**Before adding** a new `Buffer`, `SystemDescriptor`, or graph:

1. Run `npm run registry` to refresh `docs/REGISTRY.md`.
2. Search `docs/REGISTRY.md` (and `src/buffers/`, `src/systems/`) for an
   existing entry that already covers your need. If something close exists,
   extend or read it instead of creating a parallel one.
3. If you must add a new entry:
   - Give it a clear `description` field. It will be rendered in the doc.
   - Declare every buffer it reads or writes. Hazards are validated at
     `buildExecutionGraph` time, but only if you declare them honestly.
   - Add a test in `tests/buffers/` or `tests/systems/` (TDD: write the test
     first).
4. Run `npm run registry` again so the doc reflects the new entry.

**Updating an existing entry**: change the `description`, `buffers`, or
ordering metadata in the TS file, then run `npm run registry`. Don't edit
`docs/REGISTRY.md` by hand — the next regen will overwrite it.

---

## TDD expectation

Every system, every buffer, every utility ships with tests. No exceptions.
The runtime + lib already cover topo-sort, cycle detection, hazard
validation, FSM transitions/guards/hooks, spatial-hash queries, registry
uniqueness, and scheduler execution order. Maintain that bar.

For systems specifically: drive them with synthetic buffer state in tests,
not with the real Three.js render path. Three.js coupling lives in
`src/render/scene.ts` and the `RenderSystem`; everything else should be
testable headless.

---

## Common commands

```bash
npm run dev          # vite dev server at http://127.0.0.1:5173
npm test             # vitest run (everything)
npm run registry     # regenerate docs/REGISTRY.md from TS code
npx tsc --noEmit     # type check
npx vite build       # production bundle
```

---

## Out of scope (don't add without explicit ask)

- YAML registries — TS is authoritative; the `npm run registry` script dumps
  YAML/Markdown if needed.
- Multiple modes (2D dungeon, RTS, etc.) — the architecture allows graph
  swapping via the SM, but only `Running` and `Rebuilding` graphs exist
  today.
- Vectorized/SIMD buffer layouts — `Buffer<T>` doesn't preclude them; switch
  the offending `T` when the data sizes warrant it.
- Auto-generated DAGs / metaprogramming — explicit data only.

---

## Don't break

- The 35 pre-V0 tests in `tests/{rng,geom,parseBitmap,splitLayers,components,footprint}.test.ts`.
  They're the contract for the existing pipeline.
- Functional parity for the canyon-desert and forest-clearing scenes during
  migration. If a refactor would change the rendered output, stop and ask.
- The shared-lib layer rules. If you find yourself wanting to import
  `three` into `src/lib/`, stop — it belongs in `src/render/` or a system.
