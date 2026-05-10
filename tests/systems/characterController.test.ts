import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../../src/buffers/characterController";
import { CHARACTER_INPUT_BUFFER_ID, type CharacterInputBufferData, emptyInput } from "../../src/buffers/characterInput";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../../src/buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../../src/buffers/velocity";
import { SURFACE_ATTACHMENT_BUFFER_ID, type SurfaceAttachmentBufferData } from "../../src/buffers/surfaceAttachment";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createCharacterControllerSystem } from "../../src/systems/characterController";

function setup() {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createCharacterControllerSystem());
  const cc = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
  const ci = reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID);
  const t = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
  const v = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
  const sa = reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);

  const id = 1;
  writeBuffer(cc, (d) => {
    d.byEntity.set(id, {
      state: "surfaceRun",
      locomotionMode: "surfaceConstrained",
      profileId: DEFAULT_PLAYER_PROFILE.id,
      lastTransitionReason: "spawn",
      timeInState: 0,
      jumpHeldLastTick: false,
    });
  });
  writeBuffer(ci, (d) => { d.byEntity.set(id, emptyInput(0)); });
  writeBuffer(t, (d) => { d.byEntity.set(id, { position: [0, 1, 0], yaw: 0, scale: 1 }); });
  writeBuffer(v, (d) => { d.byEntity.set(id, { linear: [0, 0, 0] }); });
  writeBuffer(sa, (d) => {
    d.byEntity.set(id, {
      surfaceId: "test", uv: [0.5, 0.5], offsetAlongNormal: 0.5,
      sample: { position: [0, 0, 0], normal: [0, 1, 0], tangentU: [1, 0, 0], tangentV: [0, 0, 1], slopeRad: 0, friction: 1, normalInMax: 800, normalOutMax: 200, traversable: true },
    });
  });
  const g = buildExecutionGraph({ id: "g", nodes: ["characterControllerSystem"], registry: reg });
  return { reg, cc, ci, t, v, sa, g, id };
}

describe("CharacterControllerSystem (FSM core)", () => {
  it("KeyW (forward) on surfaceRun produces forward velocity (along -Z at yaw=0)", () => {
    const { reg, ci, v, g, id } = setup();
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), moveY: 1 }); });
    executeGraph(g, reg, { dt: 0.1, now: 0 });
    const lin = readBuffer(v).byEntity.get(id)!.linear;
    expect(lin[2]).toBeLessThan(0); // moved along -Z
    expect(Math.abs(lin[0])).toBeLessThan(0.001); // no lateral velocity
  });

  it("jumpPressed on surfaceRun → state=airborne and v.y=jumpImpulse", () => {
    const { reg, ci, v, cc, g, id } = setup();
    writeBuffer(ci, (d) => { d.byEntity.set(id, { ...emptyInput(0), jumpPressed: true, jumpHeld: true, jumpHoldSec: 0 }); });
    executeGraph(g, reg, { dt: 0.016, now: 0 });
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("airborne");
    expect(after.locomotionMode).toBe("volumeConstrained");
    expect(readBuffer(v).byEntity.get(id)!.linear[1]).toBeCloseTo(DEFAULT_PLAYER_PROFILE.jumpImpulse, 5);
  });

  it("steep slope transitions surfaceRun → surfaceSlide", () => {
    const { reg, sa, cc, g, id } = setup();
    writeBuffer(sa, (d) => {
      const att = d.byEntity.get(id)!;
      att.sample = { ...att.sample!, slopeRad: 1.2 }; // > slopeRunMaxRad (0.9)
      d.byEntity.set(id, att);
    });
    executeGraph(g, reg, { dt: 0.016, now: 0 });
    const after = readBuffer(cc).byEntity.get(id)!;
    expect(after.state).toBe("surfaceSlide");
    expect(after.lastTransitionReason).toContain("slope");
  });
});
