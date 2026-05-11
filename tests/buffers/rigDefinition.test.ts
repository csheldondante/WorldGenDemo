import { describe, it, expect } from "vitest";
import { readBuffer } from "../../src/runtime/buffer";
import { createRigDefinitionBuffer } from "../../src/buffers/rigDefinition";

describe("RigDefinitionBuffer — default biped", () => {
  const rigs = readBuffer(createRigDefinitionBuffer());
  const biped = rigs.byId.get("biped");

  it("includes the default 'biped' rig", () => {
    expect(biped).toBeDefined();
  });

  it("declares named slots that resolve to valid bone indices", () => {
    if (!biped) throw new Error("no biped");
    for (const [slotName, idx] of Object.entries(biped.slots)) {
      expect(idx, `slot ${slotName}`).toBeGreaterThanOrEqual(0);
      expect(idx, `slot ${slotName}`).toBeLessThan(biped.bones.length);
    }
  });

  it("exposes feet, head, and pelvis as named slots", () => {
    if (!biped) throw new Error("no biped");
    expect(biped.slots.pelvis).toBeDefined();
    expect(biped.slots.head).toBeDefined();
    expect(biped.slots.footL).toBeDefined();
    expect(biped.slots.footR).toBeDefined();
  });

  it("satisfies the parent < self topology invariant for every bone", () => {
    if (!biped) throw new Error("no biped");
    biped.bones.forEach((bone, i) => {
      expect(bone.parent, `bone ${i} (${bone.name})`).toBeLessThan(i);
    });
  });

  it("has exactly one root (parent === -1)", () => {
    if (!biped) throw new Error("no biped");
    const roots = biped.bones.filter((b) => b.parent === -1);
    expect(roots).toHaveLength(1);
    expect(roots[0].name).toBe("pelvis");
  });

  it("declares a spine chain with valid segment indices anchored at pelvis", () => {
    if (!biped) throw new Error("no biped");
    expect(biped.chains.length).toBeGreaterThan(0);
    const spine = biped.chains.find((c) => c.name === "spine");
    expect(spine).toBeDefined();
    if (!spine) return;
    expect(spine.rootBone).toBe(biped.slots.pelvis);
    for (const idx of spine.segments) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(biped.bones.length);
    }
    expect(spine.stiffness).toBeGreaterThan(0);
    expect(spine.damping).toBeGreaterThan(0);
  });
});
