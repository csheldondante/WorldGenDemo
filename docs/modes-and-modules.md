# Modes and Modules — generalized runtime architecture

> **Status**: design proposal, 2026-05-23. Not yet implemented. This doc
> describes the architectural target; phases land incrementally per the
> TDD plan at the end.

## Vision

The runtime has exactly one primitive: an **active configuration** of
buffers + a system graph that operates on them. Everything else is a
different instance of this primitive.

* A **scene** = a configuration with world-data buffers + a graph that
  simulates that world.
* A **game mode** = a configuration ("3D third-person", "2D top-down",
  "main menu", "pause overlay").
* A **scene loader** = a configuration whose graph populates buffers and
  then triggers a swap to the loaded scene's configuration.
* A **debug gym** = a configuration with a fixed arena + cycling UI
  systems.
* A **library viewer** = a configuration whose graph reads the buffer +
  system registries and renders them.
* An **editor** = a configuration that exposes scene buffers as
  editable.
* A **menu** = a configuration with UI-driven systems and no world sim.

Switching between any of these is the **same operation**: change the
active configuration. Cycling, swapping, hot-loading, save/restore are
all variations on the same primitive.

The character controller is the same idea at a finer granularity:

* A **module slot** is an interface (= "input semantic mapping",
  "character intent", "collision", "animation", etc).
* A **module** is an implementation of a slot.
* A **controller** = a binding of `{slot → module}` for one character
  archetype.
* Different characters (biped, vehicle, drone) are different bindings of
  the same slots.

Composition + cycling at module granularity feeds the debug gym, where a
character's slot bindings can be cloned and tweaked live.

## Core types

### Modes

```ts
interface Mode {
  /** Unique stable id; the dropdown picks by this. */
  id: string;
  /** Display name + searchable metadata. */
  label: string;
  tags?: string[];

  /** System graph executed each tick while this mode is active. */
  graph: ExecutionGraph;

  /** Buffer ids this mode requires to exist + populate from. Owned
   *  buffers are scoped to this mode (cleared on exit). Shared buffers
   *  persist across mode switches (e.g., input devices, transform of
   *  the active character). */
  ownedBuffers: BufferId[];
  sharedBuffers: BufferId[];

  /** Optional transitions to other modes. Keyed by destination mode id.
   *  Missing entry → use the default jump transition. */
  transitions?: Record<string, TransitionId>;
}
```

### Mode registry

```ts
interface ModeRegistry {
  register(mode: Mode): void;
  get(id: string): Mode | undefined;
  list(filter?: { tags?: string[]; search?: string }): Mode[];
}
```

Modes are registered at startup (= the runtime's seed modes) and can be
registered dynamically (= a scene loader registers the scene as a mode
upon load completion).

`StateMachineBuffer.activeMode: string` (= mode id) replaces today's
hardcoded `activeGraph` enum. The scheduler looks up the mode by id and
executes its graph.

### Transitions

```ts
interface Transition {
  id: TransitionId;
  from: string;  // source mode id
  to: string;    // destination mode id

  /** Graph executed during the transition. May reference both source
   *  and destination buffers; this is how data projection between
   *  incompatible representations works (= 3D → 2D shares a buffer of
   *  projected character positions). */
  graph: ExecutionGraph;

  /** Predicate or duration that completes the transition. */
  isComplete: (ctx: TickCtx) => boolean;
}
```

The default transition is **jump** (= no intermediate graph, swap
immediately on tick boundary). Custom transitions exist for incompatible
buffer sets (= scene loader, 3D ↔ 2D projection, save/restore).

### Module slots (character controller)

```ts
interface ModuleSlot {
  /** Stable id (e.g. "characterIntent", "collision", "animation"). */
  slotId: string;
  /** Interface contract: which buffers the module reads/writes,
   *  what semantic role it plays. */
  interfaceId: string;
}

interface Module {
  id: string;             // implementation id
  slotId: string;         // which slot it fills
  system: SystemDescriptor;
  /** Parameters this module exposes for live tweaking. */
  params: ParameterSchema;
}

interface ControllerBinding {
  id: string;             // archetype id (e.g. "biped", "vehicle")
  bindings: Record<string, string>;  // slotId → moduleId
  paramOverrides?: Record<string, Record<string, unknown>>;
}
```

The character controller's system descriptor becomes a thin shell that
dispatches per-slot to the bound module's system. Clone-and-tweak = copy
the binding, edit one slot's moduleId or paramOverride.

### Slot list (initial)

Ordered by tick flow:

1. **inputNormalization** — raw devices → normalized device-agnostic
   values.
2. **inputSemanticMapping** — normalized → semantic actions (move, look,
   jump, action).
3. **cameraIntent** — semantic input + camera state → camera intent
   buffer.
4. **characterIntent** — semantic input + camera basis + surface state →
   character intent buffer.
5. **cameraUpdate** — camera intent + smoothing/constraints → camera
   transform.
6. **collision** — body shape + velocity + surface → contact + events.
7. **characterUpdate** — character intent + collision + FSM → new
   character state.
8. **physics** — gravity + external forces + integration.
9. **animation** — root motion + body-segment skeleton → segment
   transforms (procedural).

## Serialization

Buffers are already JSON-shaped per the data-oriented-design rule
(`.claude/rules/coding_practices.md` rule 1). System graphs are
declarative DAGs of system IDs. So serialization is essentially free:

```ts
interface ModeSnapshot {
  modeId: string;
  buffers: Record<BufferId, unknown>;  // JSON-of-buffer-data per owned buffer
  /** Excludes RenderRefsBuffer (Three.js handles) and other non-serializable.
   *  Excluded buffers are listed for the restore step to reconstruct. */
  excluded: BufferId[];
  /** Active controller bindings, keyed by entity id. */
  bindings?: Record<EntityId, ControllerBinding>;
}
```

`serializeMode(modeId) → ModeSnapshot` and `deserializeMode(snapshot) →
Mode` are runtime methods. The buffer-snapshot test framework already
implements 90% of this; reuse the serializer.

Use cases:

* **Save game** = `serializeMode(currentMode)` → write JSON to disk.
* **Load game** = activate "scene loader" mode with the JSON as input;
  on completion, restore mode + buffers.
* **Editor save** = same, for editing tools.
* **Replay** = serialize at intervals; reactivate to scrub.

Versioning: each `Mode` declares a schema version per owned buffer;
deserialize runs a migration step if needed.

## Cycling UX

A debug overlay (= initially keyboard-driven, later a dropdown widget)
shows:

* The mode registry filtered by `tags` (= "scene", "menu", "debug",
  "editor").
* Current active mode highlighted.
* Switch action = trigger the matching transition (or jump if none
  declared).
* Clone-current-mode action = make a runtime copy with editable buffers
  (= debug gym pattern; live edits don't mutate the original).
* Search input (= name + tag fuzzy match).

The same dropdown handles controller cycling within a mode (= the active
character's `ControllerBinding` is selectable from the bindings registry,
optionally cloned + tweaked).

## Menus + editors

Menus are modes whose graph runs no simulation, just UI systems
(`menuInput`, `menuRender`). Selecting "Play" triggers a transition to
the gameplay mode.

Editors are modes that:

* Share the scene's content buffers with read-write access.
* Add editor-specific tooling systems (= selection, gizmos, save/load).
* Suspend the gameplay simulation graph (= the scene loader's graph,
  not editor's, populates and edits).

The existing `BuilderBuffer` + `BUILDER_MODE` is the prototype.

## Phased implementation

Each phase: design check → TDD → implement → snapshot baseline → ship.

### Phase 1 — ModeRegistry + StateMachine generalization (foundation)

* Add `ModeRegistry` with `register`/`get`/`list`.
* Migrate the 3 current graphs (Loading, Rebuilding, Running) into
  registered Modes.
* `StateMachineBuffer.activeMode: string` replaces hardcoded enum.
* No behavior change; pure refactor.

**Tests** (TDD):
* Register N modes; `list()` returns them filtered by tags.
* `activeMode` switch causes scheduler to execute target graph.
* `coreGraphs` canary still validates all 3 seed modes.
* Existing scenario baselines unchanged (= no behavior change).

### Phase 2 — Scenes as modes

* Each scene (= folder under `public/maps/`) registers as a Mode at
  startup (or on demand via a lazy loader).
* `?map=forest-clearing` = activate that mode.
* "Scene loader" mode (= the buffers-populating mode) declares a
  transition to the target scene mode on completion.

**Tests**:
* Loading a scene-mode populates the expected buffers.
* Switching between two scene-modes preserves shared input/camera
  buffers but resets world-data buffers.
* Scenario harness rebases on mode-id instead of legacy graph names.

### Phase 3 — Transitions with shared buffers

* Add `Transition` type + registry.
* `TransitionExecutor` runs the transition graph each tick until
  `isComplete`.
* Define one nontrivial transition (= 3D-mode ↔ top-down-mode toy
  demo) sharing a `ProjectedCharacterPosition` buffer.

**Tests**:
* Synthetic 3D-mode + 2D-mode + transition between them. Verify the
  shared buffer carries projected position across the swap.
* Transition completion fires the destination-mode activation exactly
  once.

### Phase 4 — Module slots + Controller bindings

* Define the 9 slot interfaces.
* Refactor existing character systems to fit slot boundaries:
  * `cameraMovement` → `cameraIntent` + `cameraUpdate`.
  * `tangentInputMapper` → `characterIntent`.
  * `surfaceConstrainedVelocity` → `collision` + `physics`.
  * `characterController` (FSM) → `characterUpdate`.
  * (Animation slot stubbed for now; procedural-animation system
    lands when multi-segment bodies arrive.)
* Add `ModuleRegistry` + `ControllerBinding` + a "biped" binding
  populated from current systems.

**Tests**:
* Each slot's interface contract: synthetic input/output buffers test
  the module in isolation.
* Two distinct bindings exist (= biped + a degenerate "no-op" archetype
  for testing).
* The biped binding produces identical baselines to the pre-refactor
  scenarios (= no behavior change).

### Phase 5 — Debug gym mode + clone overlay

* Register a gym Mode (= simple test arena with a controller-switching
  UI system).
* Implement the clone-and-tweak overlay: keyboard or dropdown UI
  triggers `cloneCurrentBinding()` and `swapSlot(slotId, moduleId)` /
  `setParamOverride(slotId, key, value)`.
* Live edits affect the running character without restart.

**Tests**:
* Gym launches; controller switching cycles through registered
  bindings.
* Cloning a binding + swapping one slot's module changes character
  behavior for the gym's character only.

### Phase 6 — Library viewer mode

* Register a viewer Mode that reads `BufferRegistry` +
  `SystemRegistry` + active graph and renders them.
* Cycling UI works via the same dropdown the gym uses.

**Tests**:
* Viewer mode lists all registered buffers + their current sizes.
* Live updates as a scene-mode tick mutates buffers.

### Phase 7 — Serialization round-trip

* `serializeMode(id) → ModeSnapshot` over JSON.
* `deserializeMode(snapshot)` recreates the mode + populates buffers.
* CLI: `npm run save-mode <id> <file>` / `npm run load-mode <file>`.

**Tests**:
* Round-trip equality: serialize → deserialize → serialize gives the
  same JSON (= modulo render handle exclusions).
* Scenario harness can replay a saved mode.

## What this enables (the long arc)

* **Scenarios as snapshots**: every test scenario is a mode snapshot;
  scenarios are just saved games.
* **Procedural generation**: sample controller bindings; score them
  with the scenario harness; surface a "fun-metric" leaderboard.
* **Editor**: the builder's editing tools are a registered editor mode;
  save → serializeMode.
* **Multi-modal play**: hot-swap between 3D and 2D representations of
  the same scene without restart.
* **Live testing**: clone the running scene + character into a sandbox
  mode; tweak; compare side-by-side.

All from the same primitive: `{active buffer set, active system graph}`.

## Constraints + non-goals

* **No render-thread coupling**: modes don't own Three.js handles
  directly (= `RenderRefsBuffer` is shared, recycled per mode).
* **No global state in module impls**: each module is a
  `SystemDescriptor`; no closures over external state.
* **Mode swap latency < 1 tick** for jump transitions (= no
  blocking I/O). Async loads are themselves modes (= "loader" mode
  runs until ready, then transitions).
* **No special-case logic in StateMachine** for specific modes; all
  modes go through the same path. Special behavior (= scene loaders,
  transitions) is expressed as registered modes/transitions.

## Open questions

1. **Mode lifecycle hooks** — does `onEnter`/`onExit` need to exist
   for owned-buffer reset, or is "clear owned buffers on switch"
   sufficient as a runtime rule?
2. **Concurrent modes** (= overlays like "pause menu over gameplay")
   — does this need a stack semantics, or is it always "active mode
   has full control + transparency comes from rendering the
   suspended mode's transform"?
3. **Module parameter UI** — how are parameters declared (= JSON
   schema, decorator, manual UI)? Affects the clone+tweak overlay's
   construction.
4. **Scenario harness** — does it run a mode end-to-end, or does it
   keep its own minimal-graph harness? Probably both: end-to-end mode
   runs validate integration; minimal-graph harness still tests
   individual systems in isolation.
