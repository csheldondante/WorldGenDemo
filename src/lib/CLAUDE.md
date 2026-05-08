# `src/lib/` — runtime-agnostic utilities

Generic data structures and algorithms. Nothing in here knows about the runtime, this prototype, or `three`.

## Hard layer rules

- **Must NOT import from**: `src/runtime/`, `src/buffers/`, `src/systems/`, `src/app/`, `src/render/`, `src/map/`, `src/core/`, `src/terrain/`, `src/assets/`, `three`, `playwright`, `cross-spawn`.
- May import from `node:` standard library and from devtime-only stuff like `vitest` (in tests).
- If you reach for `three` here, stop — it belongs in `src/render/` or a system.

The point is reusability across this prototype, future runtimes, and standalone tools. Tests in `tests/lib/**` exercise these in isolation; they should run without any runtime, DOM, or GPU context.

## Modules

- `dag.ts` — `Dag<NodeId>` with topo-sort (Kahn), cycle detection (Tarjan), ancestors/descendants. Used by the runtime's `ExecutionGraph` but also useful for any dependency graph.
- `stateMachine.ts` — `Fsm<S, E>`, generic finite-state-machine with declared transitions, guards, effects, enter/leave hooks, bounded history, and an `onUnhandled` callback for surfacing dropped events.
- `spatial/` — spatial indexes. Each file is a class implementing the queries that fit its shape (`insert`, `remove`, `clear`, `queryRadius`, `queryRect`, etc.). Item identity is supplied by the caller; the index doesn't own item lifecycle. See `spatialHash.ts` for the convention.
- `testing/baseline.ts` — `expectBaselined` / `expectBaselinedApprox` snapshot helpers with a custom serializer for typed arrays, Maps, Sets, and FP rounding.

## Spatial-index conventions

When adding a new index (quadtree, R-tree, BVH, etc.):

- One file per index type. Class-based, generic over item type `<T>`.
- Expose only the queries that fit the structure. Name them consistently across indexes (`queryRadius`, `queryRect`, `queryPoint`, `nearestK`).
- `size()` and `[Symbol.iterator]()` for inspection.
- Tests cover: empty index, items at far-from-origin coordinates, items at boundaries, item removal, idempotent re-insert.
- No coupling between indexes.
