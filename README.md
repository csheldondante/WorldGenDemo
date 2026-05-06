# WorldGenDemo

Browser prototype: a labeled 2D bitmap → a textured, populated 3D world you fly through, in under a second.

The pitch sidesteps LLM prompting and consumes the kind of *labeled top-down PNG* a diffusion model
would output. Each color is a semantic region. Drop a new `map.png + scene.json` into
`public/maps/` to add a new world; the *terrain vocabulary* (desert, tundra, forest, plains,
canyon_wall, water, path) is fixed in code.

## Architecture

Two pipelines meet at a single named seam (`AssetCatalog` ids):

- **Terrain pipeline** — GPU jump-flood per terrain → distance fields → softmin splat shader with
  vector-field-warped texture blending.
- **Asset pipeline** — connected components on the asset layer → footprint (centroid, hull, OBB,
  PCA principal axis, attachment contacts) → per-spec placement rules → `InstancedMesh` per asset id.

Detailed plan: see `docs/PLAN.md` (the artifact this repository implements).

## Running

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # vitest suite
npm run build      # production bundle
```

Switch scenes via `?map=forest-clearing` (no code changes between scenes).

## Scene Builder

The page has a **Scene Builder** tab (top-left) that takes any PNG, lists its distinct colors,
and lets you map each color to a terrain or asset id. It emits a `scene.json` you can drop into
`public/maps/<name>/` next to the PNG.

## Verification checklist

- [x] WASD + mouse-look fly camera.
- [x] Terrain boundaries blended with vector-field-warped noise (boundaries look organic, not fuzzy).
- [x] Cacti dot desert pixels; shanties hug canyon walls; bridges span path gaps over water.
- [x] `?map=forest-clearing` reloads the second scene. Same code.
- [x] Replace any `procedural<X>.generate` with a stub → only that asset changes.
- [x] Adding a third scene = new `public/maps/<name>/{map.png, scene.json}`. No code edits.

## Tests

```bash
npm test
```

35+ tests across `tests/`. Pure functions only — shader/render code is verified visually.
