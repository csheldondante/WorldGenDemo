# `src/buffers/` — runtime buffer rules

A buffer is a named, version-tracked data store (see `src/runtime/buffer.ts`). All runtime-visible state lives in buffers; nothing else.

## Conventions

- **One file per buffer.** Each file exports the data shape (TS interface), the buffer id constant, and a `create<Name>Buffer()` factory. `src/buffers/index.ts` calls every factory and re-exports the types.
- **Buffer id**: short, camelCase, no `Buffer` suffix in the string itself. `"camera"`, `"renderRefs"`, `"worldData"`. The constant is `CAMERA_BUFFER_ID = "camera"`.
- **`description` field** on the buffer descriptor is the docstring — it renders in `docs/REGISTRY.md`. Be specific about who writes and reads it.

## When to add a new buffer vs extend `WorldDataBuffer`

`WorldDataBuffer` holds the per-scene data slices (image, labelMap, terrainMap, assetMap, heightmap, jfa). Add a new field there if it's:

- Per-scene state (changes on rebuild, doesn't change between rebuilds).
- Read by multiple downstream pipeline stages.
- Naturally part of "the world" rather than a runtime concern.

Add a **new buffer** if it's:

- A different lifecycle (cross-rebuild, per-frame, per-mode).
- Owned by a single feature subsystem (e.g., `BuilderBuffer` for the editor — its lifetime is mode-bounded, not scene-bounded).
- Has its own version-bumping rhythm distinct from world data.

## Version semantics

`writeBuffer(b, mut)` always bumps `version`. `readBuffer(b)` does not. A reader can detect "did this change since last frame?" by snapshotting `b.version`. Don't bump `version` artificially — it's a coherence signal.

## Don't break

- Don't put functions or class instances inside buffer data unless they're DOM/Three.js handles owned by `RenderRefsBuffer` (which is the canonical "I hold non-pure references" buffer). Pure data preferred.
- Don't reach across buffers inside an `execute()` to read another buffer's `version` and skip work — use the `runOncePerRebuild` idiom (`src/systems/pipeline/common.ts`) or its equivalent for non-pipeline systems.

@import ../../.claude/rules/registry.md
