/**
 * ProfileEditor mode — tests:
 *   - applyProfileEdit mutates CharacterControllerProfileBuffer.byId.
 *   - The render system writes form HTML reflecting current profile.
 *   - The mode is registered with the expected systems list.
 *
 * The editor reads CharacterControllerProfileBuffer directly — there
 * is no snapshot buffer (per user DOD direction 2026-05-23: don't
 * duplicate canonical buffer data into an intermediary).
 */

import { describe, it, expect } from "vitest";
import { createRegistry, type Registry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  createProfileEditorBuffer,
  createProfileEditorRenderSystem,
  registerProfileEditorMode,
  applyProfileEdit,
  cloneActiveProfile,
  PROFILE_EDITOR_BUFFER_ID,
  PROFILE_EDITOR_RENDER_SYSTEM_ID,
  PROFILE_EDITOR_MODE_ID,
  type ProfileEditorBufferData,
} from "../../src/app/profileEditor";
import {
  createCharacterControllerBuffer,
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../../src/buffers/characterController";
import {
  createCharacterControllerProfileBuffer,
  DEFAULT_PLAYER_PROFILE,
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  type CharacterControllerProfileBufferData,
} from "../../src/buffers/characterControllerProfile";

function setup(target?: { innerHTML: string; style?: { display: string } } | null): {
  reg: Registry;
  tick: () => void;
} {
  const reg = createRegistry();
  reg.registerBuffer(createCharacterControllerProfileBuffer());
  reg.registerBuffer(createProfileEditorBuffer());
  reg.registerSystem(createProfileEditorRenderSystem(target ?? null));
  writeBuffer(
    reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID),
    (d) => { d.byId.set(DEFAULT_PLAYER_PROFILE.id, DEFAULT_PLAYER_PROFILE); },
  );
  // Editor binds to the default profile's own id ("player"). The live
  // runtime uses "default" because characterBindings.materializeBindings
  // forces that id; tests don't run that path, so we point at the
  // profile's actual id here.
  writeBuffer(
    reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID),
    (d) => { d.activeProfileId = DEFAULT_PLAYER_PROFILE.id; },
  );
  const graph = buildExecutionGraph({
    id: "test",
    nodes: [PROFILE_EDITOR_RENDER_SYSTEM_ID],
    registry: reg,
  });
  return {
    reg,
    tick: () => executeGraph(graph, reg, { dt: 1 / 60, now: 0 }),
  };
}

describe("ProfileEditor mode", () => {
  it("applyProfileEdit mutates CharacterControllerProfileBuffer.byId", () => {
    const { reg } = setup();
    applyProfileEdit(reg, "forwardVMax", 12.5);
    const profiles = readBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
    expect(profiles.byId.get(DEFAULT_PLAYER_PROFILE.id)!.forwardAccel.vMax).toBe(12.5);
  });

  it("applyProfileEdit on lateralAccelAtZero updates the right field", () => {
    const { reg } = setup();
    applyProfileEdit(reg, "lateralAccelAtZero", 7);
    const profiles = readBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
    expect(profiles.byId.get(DEFAULT_PLAYER_PROFILE.id)!.lateralAccel.accelAtZero).toBe(7);
  });

  it("applyProfileEdit on slideGripScale updates the top-level field", () => {
    const { reg } = setup();
    applyProfileEdit(reg, "slideGripScale", 2.5);
    const profiles = readBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
    expect(profiles.byId.get(DEFAULT_PLAYER_PROFILE.id)!.slideGripScale).toBe(2.5);
  });

  it("applyProfileEdit on a profile id not in the buffer is a no-op (does not throw)", () => {
    const { reg } = setup();
    writeBuffer(reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID), (d) => {
      d.activeProfileId = "nonexistent";
    });
    expect(() => applyProfileEdit(reg, "forwardVMax", 1)).not.toThrow();
    const profiles = readBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
    expect(profiles.byId.get(DEFAULT_PLAYER_PROFILE.id)!.forwardAccel.vMax).toBe(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax);
  });

  it("render system writes form markup with data-pe-field attributes matching the profile fields", () => {
    const target = { innerHTML: "", style: { display: "block" } };
    const { tick } = setup(target);
    tick();
    expect(target.innerHTML).toContain("Profile Editor");
    expect(target.innerHTML).toContain(`data-pe-field="forwardVMax"`);
    expect(target.innerHTML).toContain(`data-pe-field="slideGripScale"`);
    expect(target.innerHTML).toContain(`data-pe-field="desiredTurnRate"`);
  });

  it("render system writes the current value (= no snapshot drift); edits reflect on next tick", () => {
    const target = { innerHTML: "", style: { display: "block" } };
    const { reg, tick } = setup(target);
    tick();
    expect(target.innerHTML).toContain(`value="${DEFAULT_PLAYER_PROFILE.forwardAccel.vMax}"`);
    applyProfileEdit(reg, "forwardVMax", 11.25);
    tick();
    expect(target.innerHTML).toContain(`value="11.25"`);
  });

  it("render system shows a placeholder message when the active profile id has no profile", () => {
    const target = { innerHTML: "", style: { display: "block" } };
    const { reg, tick } = setup(target);
    writeBuffer(reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID), (d) => {
      d.activeProfileId = "nonexistent";
    });
    tick();
    expect(target.innerHTML).toContain("no profile");
  });

  it("render system no-ops when target is null", () => {
    const { tick } = setup(null);
    expect(() => tick()).not.toThrow();
  });

  it("cloneActiveProfile copies the active profile under a new id + repoints the editor", () => {
    const { reg } = setup();
    const newId = cloneActiveProfile(reg);
    expect(newId).toBe(`${DEFAULT_PLAYER_PROFILE.id}-clone-1`);
    const profiles = readBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
    // Original preserved.
    expect(profiles.byId.has(DEFAULT_PLAYER_PROFILE.id)).toBe(true);
    // Clone present + has same values.
    expect(profiles.byId.has(newId!)).toBe(true);
    expect(profiles.byId.get(newId!)!.forwardAccel.vMax).toBe(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax);
    // Editor's activeProfileId points at the clone.
    expect(readBuffer(reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID)).activeProfileId).toBe(newId);
  });

  it("cloneActiveProfile picks the next free numeric suffix", () => {
    const { reg } = setup();
    cloneActiveProfile(reg);
    cloneActiveProfile(reg);
    const third = cloneActiveProfile(reg);
    // After the first clone, activeProfileId == "player-clone-1"; the
    // second clone strips the suffix from the base + picks "-clone-2";
    // the third strips again + picks "-clone-3".
    expect(third).toBe(`${DEFAULT_PLAYER_PROFILE.id}-clone-3`);
  });

  it("editing the clone does NOT affect the original", () => {
    const { reg } = setup();
    cloneActiveProfile(reg);
    applyProfileEdit(reg, "forwardVMax", 99);
    const profiles = readBuffer(reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
    expect(profiles.byId.get(DEFAULT_PLAYER_PROFILE.id)!.forwardAccel.vMax).toBe(DEFAULT_PLAYER_PROFILE.forwardAccel.vMax);
    expect(profiles.byId.get(`${DEFAULT_PLAYER_PROFILE.id}-clone-1`)!.forwardAccel.vMax).toBe(99);
  });

  it("cloneActiveProfile repoints CharacterController entities referencing the old profile id", () => {
    const { reg } = setup();
    // Add a synthetic CharacterControllerBuffer with an entity using
    // the default profile id; verify clone repoints it.
    reg.registerBuffer(createCharacterControllerBuffer());
    writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
      d.byEntity.set(1, {
        locomotionMode: "surfaceConstrained",
        state: "surfaceRun",
        profileId: DEFAULT_PLAYER_PROFILE.id,
        lastTransitionReason: "spawn",
        transitions: [],
        timeInState: 0,
        yawVel: 0,
        targetYaw: 0,
        bodyUpCurrent: [0, 0, 0, 1],
        bodyUpWorld: [0, 1, 0],
        orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
        desiredFacingTangent: [0, 0, -1],
        jumpHolding: false,
        jumpDir: [0, 0, 0],
        jumpImpulseMagMax: 0,
        jumpImpulseApplied: 0,
      });
    });
    const newId = cloneActiveProfile(reg);
    const cc = readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
    expect(cc.byEntity.get(1)!.profileId).toBe(newId);
  });

  it("registerProfileEditorMode is overlay-style — includes Running's systems + render", () => {
    const reg = createRegistry();
    const runningSystems = ["stateMachineSystem", "characterControllerSystem", "renderSystem"];
    registerProfileEditorMode(reg, runningSystems);
    const mode = reg.getMode(PROFILE_EDITOR_MODE_ID);
    expect(mode).toBeDefined();
    // All underlying systems present (= gameplay continues).
    for (const id of runningSystems) {
      expect(mode!.systems).toContain(id);
    }
    // Plus the editor render system.
    expect(mode!.systems).toContain(PROFILE_EDITOR_RENDER_SYSTEM_ID);
    expect(mode!.tags).toContain("debug");
    expect(mode!.ownedBuffers).toContain(PROFILE_EDITOR_BUFFER_ID);
  });

  it("registerProfileEditorMode dedupes systems that are already in the underlying list", () => {
    const reg = createRegistry();
    registerProfileEditorMode(reg, [PROFILE_EDITOR_RENDER_SYSTEM_ID, "stateMachineSystem"]);
    const mode = reg.getMode(PROFILE_EDITOR_MODE_ID)!;
    const count = mode.systems.filter((id) => id === PROFILE_EDITOR_RENDER_SYSTEM_ID).length;
    expect(count).toBe(1);
  });
});
