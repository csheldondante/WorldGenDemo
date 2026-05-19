import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { createInputMapBuffer, INPUT_MAP_BUFFER_ID, emptyButtonState, type InputMapBufferData } from "../../src/buffers/inputMap";
import { createProfileEditorBuffer, PROFILE_EDITOR_BUFFER_ID, type ProfileEditorBufferData } from "../../src/buffers/profileEditor";
import {
  createCharacterControllerBuffer,
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
  type CharacterControllerComponent,
} from "../../src/buffers/characterController";
import {
  createCharacterControllerProfileBuffer,
  CHARACTER_CONTROLLER_PROFILE_BUFFER_ID,
  DEFAULT_PLAYER_PROFILE,
  type CharacterControllerProfileBufferData,
} from "../../src/buffers/characterControllerProfile";
import { createProfileEditorSystem, PROFILE_EDITOR_SYSTEM_ID } from "../../src/systems/profileEditor";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createInputMapBuffer());
  reg.registerBuffer(createProfileEditorBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerBuffer(createCharacterControllerProfileBuffer());
  reg.registerSystem(createProfileEditorSystem());
  const g = buildExecutionGraph({
    id: "g",
    nodes: [PROFILE_EDITOR_SYSTEM_ID],
    registry: reg,
  });
  // Seed a character controller component pointing at the default profile.
  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
  writeBuffer(cc, (d) => {
    const ctrl: CharacterControllerComponent = {
      profileId: "player",
      locomotionMode: "surfaceConstrained",
      state: "surfaceRun",
      lastTransitionReason: "",
      timeInState: 0,
      bodyUpCurrent: [0, 0, 0, 1],
      bodyUpWorld: [0, 1, 0],
      desiredFacingTangent: [0, 0, -1],
      jumpDir: [0, 0, 0],
      jumpHolding: false,
      jumpImpulseApplied: 0,
      jumpImpulseMagMax: 0,
      orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      targetYaw: 0,
      yawVel: 0,
      transitions: [],
    } as unknown as CharacterControllerComponent;
    d.byEntity.set(1, ctrl);
  });
  return { reg, g };
}

function press(reg: ReturnType<typeof createRegistry>, action: keyof InputMapBufferData["actions"]) {
  const im = reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID);
  writeBuffer(im, (d) => {
    d.actions[action] = { ...emptyButtonState(), pressed: true, held: true };
  });
}

function clearActions(reg: ReturnType<typeof createRegistry>) {
  const im = reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID);
  writeBuffer(im, (d) => {
    for (const k of Object.keys(d.actions) as (keyof typeof d.actions)[]) {
      d.actions[k] = emptyButtonState();
    }
  });
}

describe("ProfileEditorSystem", () => {
  it("toggleProfileEditor flips visibility", () => {
    const { reg, g } = setup();
    const editor = reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID);
    expect(readBuffer(editor).visible).toBe(false);

    press(reg, "toggleProfileEditor");
    executeGraph(g, reg, { dt: 0.016, now: 100 });
    expect(readBuffer(editor).visible).toBe(true);

    clearActions(reg);
    press(reg, "toggleProfileEditor");
    executeGraph(g, reg, { dt: 0.016, now: 200 });
    expect(readBuffer(editor).visible).toBe(false);
  });

  it("toggle latches editingEntity to the first character on open", () => {
    const { reg, g } = setup();
    const editor = reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID);
    press(reg, "toggleProfileEditor");
    executeGraph(g, reg, { dt: 0.016, now: 100 });
    expect(readBuffer(editor).editingEntity).toBe(1);
  });

  it("cycleProfileNext wraps through registered profiles", () => {
    const { reg, g } = setup();
    const prof = reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID);
    // Add a second profile so cycle has somewhere to go.
    writeBuffer(prof, (d) => {
      d.byId.set("scout", { ...DEFAULT_PLAYER_PROFILE, id: "scout", name: "scout" });
    });
    const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);

    press(reg, "cycleProfileNext");
    executeGraph(g, reg, { dt: 0.016, now: 100 });
    expect(readBuffer(cc).byEntity.get(1)!.profileId).toBe("scout");

    clearActions(reg);
    press(reg, "cycleProfileNext");
    executeGraph(g, reg, { dt: 0.016, now: 200 });
    expect(readBuffer(cc).byEntity.get(1)!.profileId).toBe("player"); // wraps back
  });

  it("cycleProfilePrev wraps in the opposite direction", () => {
    const { reg, g } = setup();
    const prof = reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID);
    writeBuffer(prof, (d) => {
      d.byId.set("scout", { ...DEFAULT_PLAYER_PROFILE, id: "scout", name: "scout" });
    });
    const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);

    press(reg, "cycleProfilePrev");
    executeGraph(g, reg, { dt: 0.016, now: 100 });
    // From "player" (index 0), prev wraps to "scout" (index 1).
    expect(readBuffer(cc).byEntity.get(1)!.profileId).toBe("scout");
  });

  it("cloneProfile creates a new profile id and switches the character to it", () => {
    const { reg, g } = setup();
    const prof = reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID);
    const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);

    press(reg, "cloneProfile");
    executeGraph(g, reg, { dt: 0.016, now: 100 });
    const profAfter = readBuffer(prof);
    expect(profAfter.byId.size).toBe(2);
    expect(profAfter.byId.has("player-clone")).toBe(true);
    expect(readBuffer(cc).byEntity.get(1)!.profileId).toBe("player-clone");

    // Cloning again from the clone produces a numbered suffix, not chained.
    clearActions(reg);
    press(reg, "cloneProfile");
    executeGraph(g, reg, { dt: 0.016, now: 200 });
    expect(readBuffer(prof).byId.has("player-clone-2")).toBe(true);
  });

  it("cloned profile is deep-independent of the source (mutating one does not affect the other)", () => {
    const { reg, g } = setup();
    const prof = reg.getBuffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID);

    press(reg, "cloneProfile");
    executeGraph(g, reg, { dt: 0.016, now: 100 });

    writeBuffer(prof, (d) => {
      const clone = d.byId.get("player-clone")!;
      clone.desiredRunSpeed = 12;
      clone.jump.upSpeed = 99;
    });
    const sourceAfter = readBuffer(prof).byId.get("player")!;
    expect(sourceAfter.desiredRunSpeed).toBe(DEFAULT_PLAYER_PROFILE.desiredRunSpeed);
    expect(sourceAfter.jump.upSpeed).toBe(DEFAULT_PLAYER_PROFILE.jump.upSpeed);
  });

  it("does nothing when no action is pressed (idempotent silent tick)", () => {
    const { reg, g } = setup();
    const editor = reg.getBuffer<ProfileEditorBufferData>(PROFILE_EDITOR_BUFFER_ID);
    const before = JSON.stringify({ ...readBuffer(editor) });
    executeGraph(g, reg, { dt: 0.016, now: 100 });
    const after = JSON.stringify({ ...readBuffer(editor) });
    expect(after).toBe(before);
  });
});
