# Pipeline — bitmap → 3D world

> The transformation that turns `public/maps/<name>/{map.png, scene.json}` into a textured, populated 3D world you fly through.

## At-a-glance

```
┌─────────────────────────┐
│  public/maps/<name>/    │
│    map.png              │  Per-pixel RGBA
│    scene.json           │  color → terrain/asset id
└──────────┬──────────────┘
           ▼
   parseBitmap   ─→ labelMap (W×H of color hashes)
           ▼
   splitLayers   ─→ terrainMap, assetMap (W×H each, of ids)
           ▼
   heightmap     ─→ Heightmap (W×H of floats, derived from terrain)
           ▼                              │
   jfa           ─→ jumpFlood arrays      │
           ▼                              ▼
   terrainMesh   ─→ THREE.Mesh (textured slab)
           ▼
   assetPlacement─→ THREE.Mesh per asset id (instanced)
           ▼
   surfaceProvider ─→ HeightmapSurfaceProvider
           ▼
   playerSpawn   ─→ entity with Transform + Velocity + … + SurfaceAttachment
           ▼
   render        ─→ Three.js draws everything
```

Each row is a **pure transformation module** in `src/map/` / `src/core/` / `src/terrain/` / `src/assets/` / `src/render/`, wrapped by a **runtime system** in `src/systems/pipeline/` that handles I/O and timing. Pure modules are headless-testable; systems handle the buffer-mutation + once-per-rebuild bookkeeping via `runOncePerRebuild` (see `src/systems/pipeline/common.ts`).

## Stages, in order

### 1. parseBitmap (`src/map/parseBitmap.ts`)

`(ImageData, w, h) → labelMap: Uint32Array`

Converts the RGBA pixels into a per-pixel color hash. The output `labelMap[i] = (r << 16) | (g << 8) | b`. Test: `tests/parseBitmap.test.ts`. Behavior is locked in by baseline snapshot.

### 2. splitLayers (`src/map/splitLayers.ts`)

`(labelMap, scene) → { terrainMap, assetMap }`

Looks up each label hash in `scene.labels[]` and routes it to either the terrain layer (`terrainMap[i] = terrainId`) or the asset layer (`assetMap[i] = assetId`). Pixels with no matching label become `0` in both. The `scene.json` palette is the only place colors are interpreted; everything downstream is by id.

### 3. heightmap (`src/map/heightmap.ts`)

`(terrainMap, w, h, tileSize) → Heightmap`

Per-terrain height lookup (canyon walls high, plains flat, water below grade) plus a smoothing pass. The output is a `Heightmap = { width, height, tileSize, data: Float32Array }` — also the core data for the `HeightmapSurfaceProvider`.

### 4. jfa (`src/map/jfa.ts`)

`(layer, w, h) → distance + nearest-id arrays`

Jump-flood algorithm — builds a per-pixel "distance to nearest non-zero region" + "nearest region id." Used downstream for asset edge-affinity (e.g., bridges anchor at boundaries) and texture splatting.

### 5. terrainMesh (`src/map/terrainMesh.ts`)

`(heightmap, terrainMap, jfa) → THREE.Mesh`

Builds one large textured plane mesh, displaced by the heightmap, with per-vertex terrain-id attributes. Materials use `splatShader` (`src/render/splatShader.ts`) to blend procedural textures (`src/terrain/textures.ts`) at boundaries based on JFA distances.

### 6. assetPlacement (`src/map/placeAssets.ts` + `src/map/components.ts` + `src/map/footprint.ts`)

`(assetMap, jfa, heightmap, catalog) → instances per assetId`

Detects connected components in the assetMap, computes their footprints, validates against catalog rules (e.g., bridges need to span water; cacti can't sit on canyon_wall; shanties need contact with canyon_wall), and emits `THREE.InstancedMesh` per asset id. Procedural geometry per id lives in `src/assets/procedural<Foo>.ts`.

### 7. surfaceProvider (`src/world/surfaceProvider.ts`)

`(heightmap) → HeightmapSurfaceProvider`

Wraps the heightmap with the `SurfaceProvider` interface (sampleAtUV, worldToUV, uvToWorld, canAttachAt, sampleVelocityAt). This is the physics surface the character solver runs against.

### 8. playerSpawn (`src/systems/pipeline/playerSpawn.ts`)

On first rebuild: spawns the player entity (one in V1) with all its components: Transform, Velocity, ForceAccumulator, SphereBody, CharacterController, CharacterInput, SurfaceAttachment. Re-attaches existing player on later rebuilds.

### 9. render (`src/systems/render.ts`)

Three.js draws everything in `scene.json`'s configured order. Per-frame; not part of the rebuild pipeline.

## Adding a stage

1. Add a pure function in `src/map/` (or appropriate layer module).
2. Add the system wrapper in `src/systems/pipeline/` using `runOncePerRebuild`.
3. Insert into the Rebuilding graph (`src/app/graphs.ts`) at the right point.
4. Declare buffer access (`runsAfter` for any prior writers).
5. Register in `src/systems/index.ts`.
6. Run `npm run registry`; the new stage appears in `docs/REGISTRY.md`.
7. Add a test — pure-function in `tests/<stage>.test.ts` or pipeline-level in `tests/migration/`.

If your stage produces buffer state used by multiple downstream stages, prefer extending `WorldDataBuffer` (`src/buffers/worldData.ts`); see `src/buffers/CLAUDE.md` for the rule.

## Rebuilding state machine

`Loading → Rebuilding → Running` cycles cleanly. `RebuildRequested { payload }` events queue a fresh rebuild. The runtime FSM (`src/runtime/stateMachine.ts`) gates which graph runs at a given tick. The Rebuilding graph runs each stage exactly once per generation via `runOncePerRebuild`; the Running graph excludes pipeline systems. See `src/runtime/CLAUDE.md` and `src/systems/CLAUDE.md`.

## Tests

- Pure transformations: `tests/parseBitmap.test.ts`, `tests/splitLayers.test.ts`, `tests/components.test.ts`, `tests/footprint.test.ts`. Baseline snapshots are the regression detector.
- Integration: `tests/migration/rebuildPipeline.test.ts` runs a synthetic input through the full Rebuilding graph and asserts buffer state.
- Canary: `tests/migration/coreGraphs.test.ts` validates every registered graph; **if it fails, the dev server boots to a black screen with no error.**

## Smoke harness

`npm run smoke` boots Vite + headless Chromium, captures `console.log`, `network.log`, `page.png`, `state.json` to `smoke-out/`. Use it to verify the whole chain end-to-end before claiming a visual fix works. See `tests/CLAUDE.md`.
