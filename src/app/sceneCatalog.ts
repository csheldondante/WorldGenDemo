/**
 * Catalog of available gameplay scenes (= `public/maps/<id>/`). Used by
 * bootstrap to register each scene as a Mode via `registerSceneModes`.
 *
 * Hardcoded for now — when the runtime needs more scenes than is
 * practical to hand-maintain, replace with a build-time directory
 * scan. Keep this in sync with `public/maps/`.
 */

import type { SceneModeSeed } from "../runtime/sceneModes";

export const SCENE_CATALOG: SceneModeSeed[] = [
  { id: "canyon-desert", label: "Canyon Desert" },
  { id: "forest-clearing", label: "Forest Clearing" },
  { id: "gym-climb-tall", label: "Gym — Tall Climb", tags: ["gym"] },
  { id: "gym-climb-wall", label: "Gym — Climb Wall", tags: ["gym"] },
  { id: "gym-cylinder-concave", label: "Gym — Cylinder (Concave)", tags: ["gym"] },
  { id: "gym-cylinder-convex", label: "Gym — Cylinder (Convex)", tags: ["gym"] },
  { id: "gym-mesa", label: "Gym — Mesa", tags: ["gym"] },
  { id: "gym-plane", label: "Gym — Plane", tags: ["gym"] },
  { id: "gym-terrain-bump", label: "Gym — Terrain Bump", tags: ["gym"] },
];
