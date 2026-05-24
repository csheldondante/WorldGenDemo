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
  PROFILE_EDITOR_BUFFER_ID,
  PROFILE_EDITOR_RENDER_SYSTEM_ID,
  PROFILE_EDITOR_MODE_ID,
  type ProfileEditorBufferData,
} from "../../src/app/profileEditor";
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

  it("registerProfileEditorMode registers the mode with the expected systems list + tag", () => {
    const reg = createRegistry();
    registerProfileEditorMode(reg);
    const mode = reg.getMode(PROFILE_EDITOR_MODE_ID);
    expect(mode).toBeDefined();
    expect(mode!.systems).toContain(PROFILE_EDITOR_RENDER_SYSTEM_ID);
    expect(mode!.tags).toContain("debug");
    expect(mode!.ownedBuffers).toContain(PROFILE_EDITOR_BUFFER_ID);
  });
});
