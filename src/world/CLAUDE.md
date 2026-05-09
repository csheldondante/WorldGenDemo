# `src/world/` — surfaces, volumes, and force fields

The "world model" — generic abstractions for *what characters move on / through*.

## Surfaces

A **surface** is a 2D-parameterized 3D shape (UV → world XYZ + frame). Characters attached to a surface live in UV space. Movement is integrated in surface-tangent coordinates, then mapped back to world.

Implementations live here. V1 ships only `HeightmapSurfaceProvider`. Future: walls, spheres, custom-shape providers (climbable rocks, vehicles' decks, etc).

The `SurfaceProvider` interface is the contract. All providers must implement:

- `sampleAtUV(u, v)` → `SurfaceSample` with position + normal + tangents + slope + friction + traversable.
- `worldToUV(x, z)` → UV (used to attach characters projecting from above).
- `uvToWorld(u, v)` → world XYZ.
- `canAttachAt(u, v)` → boolean.

## Volumes (deferred)

V1 has only one logical volume — general 3D world space — and it doesn't need its own provider. When we add gravity-altering zones or other volume rules, they go in `src/world/volumes/` with a `VolumeProvider` interface.

## Force fields

Constant gravity is wired in V1 as a slot on `VolumeFieldBuffer`. When we have multiple fields (wind, low-gravity zones), they live here as small classes implementing a `ForceField.sampleAt(position) → acceleration` interface.

## Layer rules

- May import from `src/lib/`, `src/core/`, `src/map/`, `three`.
- Must NOT import from `src/buffers/`, `src/systems/`, `src/runtime/`, `src/app/`. Surface providers are pure data + math; the runtime is what wires them up via systems.
