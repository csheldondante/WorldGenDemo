# `src/runtime/` — runtime model rules

This is the foundation of the buffer/system/scheduler/state-machine architecture. It must NOT know about specific buffers or features — those live in `src/buffers/` and `src/systems/`.

## Layer rules

- May import from `src/lib/` (Dag, Fsm, generic utilities).
- Must NOT import from `src/buffers/`, `src/systems/`, `src/app/`, `src/render/`, `src/map/`, or `three`.
- The runtime is feature-agnostic; tests in `tests/runtime/` use synthetic buffers and systems.

## The four primitives

- **`Buffer<T>`**: `{ id, description, version, data }`. `version` increments on every `writeBuffer()`; readers can detect changes by snapshotting it. Buffers carry a `description` field for `docs/REGISTRY.md`.
- **`SystemDescriptor`**: `{ id, description, buffers: { id, access }[], runsAfter?, runsBefore?, execute(ctx) }`. The metadata is the contract; the execute function is the work.
- **`ExecutionGraph`**: `{ id, nodes: SystemId[], edges, order: SystemId[] }` — explicit data, validated and topo-sorted by `buildExecutionGraph()`.
- **`StateMachineSystem`**: drives `activeGraph` via the FSM in `src/lib/stateMachine.ts`.

## Hazard rules — STRICT

`buildExecutionGraph()` flags three cases as hazards needing explicit ordering (`runsAfter`/`runsBefore`):

1. **Two writers on the same buffer** without ordering → throws.
2. **A reader and a writer on the same buffer** without ordering → throws.
3. (Two readers on the same buffer is FINE; no ordering needed.)

The check is transitive — if A `runsAfter` B and B `runsAfter` C, A is considered after C. Out-of-graph IDs in a `runsAfter` list are silently dropped, so one descriptor works across all graphs the system participates in.

If you add a writer to an existing shared buffer, every other writer or reader of that buffer must already have an ordering edge to/from your system, or validation throws at startup. The error names the offenders.

## Dev vs prod error handling

`src/runtime/dev.ts` exports:

- `IS_DEV` — true under `vite dev` and vitest, false under `vite build` production.
- `assertDev(cond, message)` — throws in dev/tests, logs `[assertDev:prod]` and continues in production.
- `warnDev(message, ...rest)` — dev-only `console.warn`.

Scheduler behavior (`src/runtime/scheduler.ts`):

- Always logs the system error to console and to `TimingBuffer.warnings` (rendered by HUD).
- In dev: re-throws so devtools/vitest catch the stack immediately.
- In production: swallows so the world keeps running with degraded behavior.

FSM `onUnhandled` callback fires when `dispatch()` produces no transition (either no rule matched, or rule's `to === from`). The runtime FSM in `src/runtime/stateMachine.ts` wires this to `warnDev` so dropped events surface in the dev console.

## Don't break

- The `Buffer<T>` shape is data, not behavior — never put functions on a buffer's data.
- `SystemDescriptor.execute` must be sync. Long-running work (like `LoadSceneSystem`'s fetch) holds its own promise state in a closure and polls per-tick.
- `Fsm.dispatch` treats `to === from` as a no-op (returns `transitioned: false`). If you want a real self-transition, it's not the FSM's job — capture the event payload separately. (See how `pendingLoad` is captured in the runtime SM.)

@import ../../.claude/rules/registry.md
