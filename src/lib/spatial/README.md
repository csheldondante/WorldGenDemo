# Spatial indexes

This directory holds **runtime-agnostic** spatial-index data structures. Anything that
needs spatial queries — asset placement, collision, frustum culling, pathfinding —
should pull from here rather than re-implement.

## Convention

- One file per index type. Class-based. No coupling between indexes.
- Index code does **not** import from `src/runtime/` or `src/systems/`. Lib lives
  below the runtime; the runtime consumes the lib, never vice versa.
- Each index exposes only the queries that fit its shape, named consistently:
  - `insert(item, ...)` / `remove(item)` / `clear()` / `size()`
  - `queryRect(aabb)` / `queryRadius(point, r)` / `queryPoint(point)` — only
    where the index naturally answers them
  - `[Symbol.iterator]()` — yields all stored items
- Items have stable identity supplied by the caller. The index does not own
  item lifecycle — callers are responsible for `insert` / `remove` consistency.
- Generic over the item type (`<T>`). No assumptions about `T` beyond identity
  (`Map<T, ...>` works).
- Tests live in `tests/lib/spatial/<name>.test.ts`; cover the empty index,
  boundary cells, far-from-origin queries, and item removal.

## Index choice cheat sheet

| Index | Best for | Avoid when |
|---|---|---|
| `SpatialHash2D` | many small queries with radius ≈ cellSize | very heterogeneous scales |
| (add others as written) | | |

## When to add a new index

Before writing one, search this directory and the test files for the queries
your code already needs. If an existing index covers them, reuse it. Otherwise
follow the convention above and add a new file + tests.
