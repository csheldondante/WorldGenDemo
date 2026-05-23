import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer } from "../../src/runtime/buffer";
import {
  registerSceneModes,
  type SceneModeSeed,
} from "../../src/runtime/sceneModes";
import type { SystemDescriptor } from "../../src/runtime/system";

/**
 * Phase 2 of the modes-and-modules refactor — scenes are registered
 * as Modes that share the gameplay systems list but have distinct
 * ids and (optionally) per-scene seed data. Demonstrates:
 *
 *   1. "Very different game modes" — LibraryViewer (debug) vs
 *      gameplay scenes (= running) share NO systems; switching
 *      activates a completely different graph.
 *   2. "Similar modes with different data" — every scene mode runs
 *      the same systems but with different scene-name / payload data,
 *      so switching scenes reuses the simulation without rebuilding it.
 *
 * `registerSceneModes(reg, seeds, sharedSystems)` registers each seed
 * as a Mode and returns the list of registered Mode ids. Tests here
 * use synthetic seeds + synthetic systems; bootstrap is where the
 * real `public/maps/<name>/` directories get wired in.
 */

function syntheticSystem(id: string): SystemDescriptor {
  return { id, description: id, buffers: [], execute: () => {} };
}

describe("registerSceneModes", () => {
  function setup() {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer({ id: "world-data", description: "", initial: {} }));
    reg.registerSystem(syntheticSystem("input"));
    reg.registerSystem(syntheticSystem("simulate"));
    reg.registerSystem(syntheticSystem("render"));
    return reg;
  }

  it("registers each seed as a Mode with the shared system list", () => {
    const reg = setup();
    const seeds: SceneModeSeed[] = [
      { id: "forest-clearing", label: "Forest Clearing" },
      { id: "canyon-desert", label: "Canyon Desert" },
      { id: "gym-mesa", label: "Gym — Mesa" },
    ];
    const ids = registerSceneModes(reg, seeds, ["input", "simulate", "render"]);
    expect(ids.sort()).toEqual(["canyon-desert", "forest-clearing", "gym-mesa"]);
    for (const id of ids) {
      const m = reg.getMode(id)!;
      expect(m.systems).toEqual(["input", "simulate", "render"]);
    }
  });

  it("tags scene modes with 'scene' (plus per-seed tags appended)", () => {
    const reg = setup();
    const seeds: SceneModeSeed[] = [
      { id: "gym-plane", label: "Gym Plane", tags: ["gym"] },
    ];
    registerSceneModes(reg, seeds, ["input"]);
    const tags = reg.getMode("gym-plane")!.tags!;
    expect(tags).toContain("scene");
    expect(tags).toContain("gym");
  });

  it("attaches seedData to the mode so loaders can consume it", () => {
    const reg = setup();
    const seeds: SceneModeSeed[] = [
      { id: "scene-a", label: "A", seedData: { mapUrl: "/maps/a.png" } },
      { id: "scene-b", label: "B", seedData: { mapUrl: "/maps/b.png" } },
    ];
    registerSceneModes(reg, seeds, ["input"]);
    expect(reg.getMode("scene-a")!.seedBuffers).toEqual({ "scene-a": { mapUrl: "/maps/a.png" } });
    expect(reg.getMode("scene-b")!.seedBuffers).toEqual({ "scene-b": { mapUrl: "/maps/b.png" } });
  });

  it("scenes registered this way are listable by the 'scene' tag", () => {
    const reg = setup();
    reg.registerMode({ id: "Other", label: "Other", systems: [], tags: ["debug"] });
    registerSceneModes(reg, [
      { id: "s1", label: "S1" },
      { id: "s2", label: "S2" },
    ], ["input"]);
    const scenes = reg.listModes({ tags: ["scene"] });
    expect(scenes.map((m) => m.id).sort()).toEqual(["s1", "s2"]);
    expect(scenes.every((m) => m.systems.includes("input"))).toBe(true);
  });

  it("rejects duplicate seeds", () => {
    const reg = setup();
    registerSceneModes(reg, [{ id: "x", label: "X" }], ["input"]);
    expect(() => registerSceneModes(reg, [{ id: "x", label: "X2" }], ["input"])).toThrow(/already/);
  });
});
