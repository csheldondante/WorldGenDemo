# Registry workflow

> **Cross-cutting rule.** Loaded explicitly via `@import` from root `CLAUDE.md`, `src/buffers/CLAUDE.md`, and `src/systems/CLAUDE.md`. The registry workflow applies whenever you add a new buffer, system, or graph — regardless of which folder you're editing in.

The registry is the single searchable index of every buffer, system, and graph in the runtime. The TS code in `src/buffers/index.ts` and `src/systems/index.ts` is the source of truth; `docs/REGISTRY.md` is a generated mirror.

## Before adding a new buffer, system, or graph

1. Run `npm run registry` to refresh `docs/REGISTRY.md`.
2. Search it for an existing entry that already covers your need. Prefer extending the existing one to creating a parallel one.
3. If you must add new:
   - Give it a clear `description` field — it renders in the doc.
   - Declare every buffer it reads or writes honestly. Hazards are validated at `buildExecutionGraph` time, but only if the declaration is accurate.
   - Add a test in `tests/buffers/` or `tests/systems/`.
4. Run `npm run registry` again so the doc reflects the new entry.

## After adding it

`tests/migration/coreGraphs.test.ts` is the canary — it registers all real buffers, systems, and graphs, and asserts validation passes. **If this test fails after your change, the dev server will boot to a black screen with no visible error.** Do not commit until it's green.

If you added a system that writes a buffer also read or written elsewhere, you must add a `runsAfter` (or `runsBefore`) to disambiguate ordering. The graph builder will throw at validation time naming the offending pair. Out-of-graph IDs are silently dropped, so one set of `runsAfter` declarations works across all graphs the system participates in.

## Don't edit `docs/REGISTRY.md` by hand

It is overwritten by `npm run registry`. Update the descriptions in the TS source.
