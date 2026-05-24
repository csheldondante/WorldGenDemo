import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer } from "../../src/runtime/buffer";
import { registerCoreBuffers } from "../../src/buffers";
import { registerCoreSystems } from "../../src/systems";
import { buildAndRegisterCoreGraphs } from "../../src/app/graphs";
import { registerInfrastructureSystems } from "../../src/runtime/infrastructureSystems";
import { createTransitionActivatorSystem } from "../../src/app/transitionActivator";
import { registerBipedDefaultBinding } from "../../src/app/bipedBinding";
import {
  BIPED_STANDARD,
  BIPED_AGILE,
  BIPED_STANDARD_PROFILE,
  BIPED_AGILE_PROFILE,
  BIPED_HEAVY_PROFILE,
  CHARACTER_BINDINGS,
  materializeBindings,
} from "../../src/app/characterBindings";
import { applyControllerBinding } from "../../src/app/applyControllerBinding";
import { SLOT_CHARACTER_INTENT } from "../../src/runtime/slotIds";
import {
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
  type CharacterControllerProfile,
} from "../../src/buffers/characterControllerProfile";

/**
 * Phase 5 character bindings — each binding installs a full
 * `CharacterControllerProfile` into `CharacterControllerProfileBuffer.byId`
 * via `applyControllerBinding`. Refactored 2026-05-23: bindings no
 * longer carry multiplier paramOverrides — the profile is the
 * canonical data. See
 * wiki/worldgen-demo-bindings-install-profiles-not-multipliers.
 */

describe("Character bindings catalog", () => {
  it("includes standard, agile, heavy bindings", () => {
    const ids = CHARACTER_BINDINGS.map((b) => b.id);
    expect(ids).toEqual(["biped:standard", "biped:agile", "biped:heavy"]);
  });

  it("each binding's characterIntent slotData is a CharacterControllerProfile", () => {
    for (const b of CHARACTER_BINDINGS) {
      const p = b.slotData?.[SLOT_CHARACTER_INTENT] as CharacterControllerProfile | undefined;
      expect(p).toBeDefined();
      expect(typeof p!.id).toBe("string");
      expect(typeof p!.forwardAccel.vMax).toBe("number");
      expect(typeof p!.downAccel.accelAtZero).toBe("number");
    }
  });

  it("agile profile is faster + slipperier than standard (= higher vMax, lower slideGripScale, snappier turn)", () => {
    expect(BIPED_AGILE_PROFILE.forwardAccel.vMax).toBeGreaterThan(BIPED_STANDARD_PROFILE.forwardAccel.vMax);
    expect(BIPED_AGILE_PROFILE.slideGripScale).toBeLessThan(BIPED_STANDARD_PROFILE.slideGripScale);
    expect(BIPED_AGILE_PROFILE.desiredTurnRate).toBeGreaterThan(BIPED_STANDARD_PROFILE.desiredTurnRate);
  });

  it("heavy profile is slower + grippier than standard (= lower vMax, higher slideGripScale, slower turn)", () => {
    expect(BIPED_HEAVY_PROFILE.forwardAccel.vMax).toBeLessThan(BIPED_STANDARD_PROFILE.forwardAccel.vMax);
    expect(BIPED_HEAVY_PROFILE.slideGripScale).toBeGreaterThan(BIPED_STANDARD_PROFILE.slideGripScale);
    expect(BIPED_HEAVY_PROFILE.desiredTurnRate).toBeLessThan(BIPED_STANDARD_PROFILE.desiredTurnRate);
  });

  it("materializeBindings merges biped:default slot assignments into every catalog binding", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg, { extraSystems: [createTransitionActivatorSystem()] });
    buildAndRegisterCoreGraphs(reg);
    const { binding: bipedDefault } = registerBipedDefaultBinding(reg);

    const materialized = materializeBindings(bipedDefault);
    expect(materialized.length).toBe(CHARACTER_BINDINGS.length);
    for (const m of materialized) {
      // Slot assignments come from biped:default.
      expect(m.bindings).toEqual(bipedDefault.bindings);
      // Each materialized binding's profile uses the canonical "default"
      // id so installing the binding replaces the live character's
      // profile without re-pointing it.
      const p = m.slotData?.[SLOT_CHARACTER_INTENT] as CharacterControllerProfile | undefined;
      expect(p).toBeDefined();
      expect(p!.id).toBe("default");
    }
  });

  it("applyControllerBinding installs the binding's profile into CharacterControllerProfileBuffer.byId", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg, { extraSystems: [createTransitionActivatorSystem()] });
    buildAndRegisterCoreGraphs(reg);
    const { binding: bipedDefault } = registerBipedDefaultBinding(reg);
    const materialized = materializeBindings(bipedDefault);
    const agile = materialized.find((b) => b.id === BIPED_AGILE.id)!;

    applyControllerBinding(reg, agile);
    const profiles = readBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
    const installed = profiles.byId.get("default")!;
    expect(installed.forwardAccel.vMax).toBeCloseTo(BIPED_AGILE_PROFILE.forwardAccel.vMax, 5);
    expect(installed.slideGripScale).toBeCloseTo(BIPED_AGILE_PROFILE.slideGripScale, 5);
  });

  it("re-applying standard after agile restores standard's curves (= heals drift)", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    registerCoreSystems(reg);
    registerInfrastructureSystems(reg, { extraSystems: [createTransitionActivatorSystem()] });
    buildAndRegisterCoreGraphs(reg);
    const { binding: bipedDefault } = registerBipedDefaultBinding(reg);
    const materialized = materializeBindings(bipedDefault);

    applyControllerBinding(reg, materialized.find((b) => b.id === BIPED_AGILE.id)!);
    applyControllerBinding(reg, materialized.find((b) => b.id === BIPED_STANDARD.id)!);
    const profiles = readBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
    const installed = profiles.byId.get("default")!;
    expect(installed.forwardAccel.vMax).toBeCloseTo(BIPED_STANDARD_PROFILE.forwardAccel.vMax, 5);
    expect(installed.slideGripScale).toBeCloseTo(BIPED_STANDARD_PROFILE.slideGripScale, 5);
  });
});
