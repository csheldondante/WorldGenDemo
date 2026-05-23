import { describe, it, expect } from "vitest";
import { SCENE_CATALOG } from "../../src/app/sceneCatalog";
import { createRegistry } from "../../src/runtime/registry";
import { registerSceneModes } from "../../src/runtime/sceneModes";

describe("SCENE_CATALOG", () => {
  it("contains the expected scenes", () => {
    const ids = SCENE_CATALOG.map((s) => s.id).sort();
    expect(ids).toContain("canyon-desert");
    expect(ids).toContain("forest-clearing");
    expect(ids).toContain("gym-mesa");
  });

  it("every entry has a non-empty label", () => {
    for (const s of SCENE_CATALOG) {
      expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it("scenes register cleanly with shared gameplay systems", () => {
    const reg = createRegistry();
    // SCENE_CATALOG has no seedData, so we don't need any synthetic
    // systems registered for buildExecutionGraph; we're only verifying
    // that the catalog → registry path produces N distinct scene modes.
    const ids = registerSceneModes(reg, SCENE_CATALOG, []);
    expect(ids.length).toBe(SCENE_CATALOG.length);
    const scenes = reg.listModes({ tags: ["scene"] });
    expect(scenes.length).toBe(SCENE_CATALOG.length);
  });

  it("gym-tagged scenes filter by both 'scene' and 'gym'", () => {
    const reg = createRegistry();
    registerSceneModes(reg, SCENE_CATALOG, []);
    const gyms = reg.listModes({ tags: ["scene", "gym"] });
    expect(gyms.length).toBe(SCENE_CATALOG.filter((s) => s.tags?.includes("gym")).length);
    for (const g of gyms) {
      expect(g.id.startsWith("gym-")).toBe(true);
    }
  });
});
