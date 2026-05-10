# Coding practices

> **Cross-cutting rule.** Imported by root `CLAUDE.md`. Applies to every part of the codebase.

The runtime is **data-oriented**. Behavior should fall out of pure transformations over named buffers. Reach for the shared lib (`src/lib/`) before hand-rolling local state.

## 0. Always use data-oriented design — non-negotiable

**ALWAYS USE DATA-ORIENTED DESIGN unless there is a specific reason not to. If there is, discuss that reason with the user. DO NOT silently choose to take shortcuts.**

The smaller, "pragmatic" diff that papers over an architectural seam is the wrong answer in this codebase. If you notice yourself reaching for any of these:

- a one-off branch on raw device state inside a gameplay consumer (e.g. `keys.X || gamepadButtons.has(Y)`) instead of normalizing upstream
- a closure flag (`let lastVersion = -1`) instead of a buffer field
- a class with methods instead of a buffer of plain data
- a direct method call between systems instead of an event/buffer hand-off
- reading raw input semantics in two systems instead of one mapper that produces the semantic vocabulary

...stop. That's a shortcut. Surface the architectural choice to the user with pros/cons and let them weigh in. Never make that choice silently — the user reads "default" in rule #1 below as "always, unless you've justified the exception to me."

If you find an existing place in the codebase that violated this rule (e.g., a consumer reading raw input directly when it should consume a semantic layer), call it out — it's debt worth fixing.

## 1. Data-oriented design (default)

State lives in **buffers**, mutated by **systems**, with explicit declared read/write access. Prefer:

- **Plain data over methods.** A buffer's `data` should be JSON-shaped (numbers, strings, arrays, plain objects, typed arrays). No methods, no class instances unless they're DOM/WebGL handles owned by `RenderRefsBuffer`.
- **Pure functions for transformations.** `parseBitmap`, `splitLayers`, `floodFill4`, `sceneFromPalette` etc. take data → return data. Test them headless. Wrap them in a system that handles I/O.
- **Buffers as Single Source of Truth.** If you find yourself caching state in a closure (`let painting = false`, `let lastVersion = -1`) — that state probably belongs in a buffer. Closure flags are invisible to tests, debug overlays, and replays.
- **Events are data.** New mode? Add an event variant to `RuntimeEvent` and let the SM/system handle it. Don't bypass the runtime with a direct method call.

## 2. Reach for the shared lib

`src/lib/` exists so we don't reinvent the wheel:

- **`Fsm<S, E>`** for any non-trivial sub-state. "Mid-stroke" / "post-jump apex" / "loading vs idle" are FSM states, not booleans. The lib FSM gives you `onUnhandled`, history, hooks, guards — features that compound.
- **`Dag<NodeId>`** for any dependency graph (asset deps, behavior trees, build pipelines).
- **`spatial/*`** for any spatial query (AABB tests, neighbor lookups, region queries).

If you reach for an `if/else` chain that's tracking "where am I in this multi-step process?", that's an FSM cue. If you need "what's near me?", that's a spatial-index cue.

## 3. Separate compute from rendering

When a system both **mutates a buffer** AND **writes the DOM/canvas/GL**, split it.

```
BadSystem:
  drains events; mutates BuilderBuffer; redraws DOM; calls THREE.render()

GoodPair:
  ComputeSystem  (read events, write buffer)
  RenderSystem   (read buffer, write DOM/canvas/GL)
```

Why it matters:

- The compute system stays headless-testable.
- DOM/render code can be smoke-tested in isolation.
- Other systems can react to buffer changes without piggybacking on the renderer.

V0.2 builder.ts violates this — `BuilderSystem` does both. Track this as debt; split during the next builder pass.

## 4. Tests

Per `tests/CLAUDE.md`:

- Pure transformations get **baseline-snapshot tests** (`expectBaselined`). Behavioral changes show as precise diffs.
- Systems get **synthetic-buffer tests** — drive them with hand-crafted buffer state, no DOM, no GL.
- Integration: `tests/migration/coreGraphs.test.ts` is the canary — it must validate every registered graph after any system change.

## 5. Failures should be loud in dev

Per `src/runtime/CLAUDE.md`:

- `assertDev(cond, msg)` — throws in dev/tests; logs in prod.
- `warnDev(msg)` — dev-only console warning. Use for "expected something, got nothing."
- Scheduler re-throws system errors in dev so devtools shows the stack.
- FSM `onUnhandled` callback fires when an event drops — wired in the runtime to `warnDev`.

If you find yourself silently swallowing an error or ignoring a "shouldn't happen" branch, replace with `assertDev`.

## 6. Use the smoke harness for visual claims

Before claiming "X renders correctly":

```bash
npm run smoke              # captures world boot
MODE=builder npm run smoke # captures editor + send-to-world roundtrip
```

Read `smoke-out/{console.log, network.log, page.png, state.json}` directly. The screenshot is the artifact; trust it over your mental model.

## 7. The registry is the search index

Before adding a new buffer, system, or graph: `npm run registry`, then read `docs/REGISTRY.md`. Reuse > duplicate.
