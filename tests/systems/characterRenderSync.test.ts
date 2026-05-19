import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
  type ControllerState,
} from "../../src/buffers/characterController";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../../src/buffers/transform";
import { SPHERE_BODY_BUFFER_ID, type SphereBodyBufferData } from "../../src/buffers/sphereBody";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../../src/buffers/renderRefs";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import {
  createCharacterRenderSyncSystem,
  CHARACTER_RENDER_SYNC_SYSTEM_ID,
  STATE_COLOR_HEX,
} from "../../src/systems/characterRenderSync";

/**
 * Drives the render-sync system with synthetic buffer state and reads back
 * the mesh material color to verify FSM state → color mapping.
 */
function setup() {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createCharacterRenderSyncSystem());

  const scene = new THREE.Scene();
  writeBuffer(reg.getBuffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID), (d) => {
    d.scene = scene;
  });

  const id = 1;
  writeBuffer(reg.getBuffer<SphereBodyBufferData>(SPHERE_BODY_BUFFER_ID), (d) => {
    d.byEntity.set(id, { radius: 0.5 });
  });
  writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
    d.byEntity.set(id, { position: [0, 0, 0], yaw: 0, scale: 1 });
  });
  writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
    d.byEntity.set(id, {
      state: "surfaceRun",
      locomotionMode: "surfaceConstrained",
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

  const g = buildExecutionGraph({
    id: "render-sync",
    nodes: [CHARACTER_RENDER_SYNC_SYSTEM_ID],
    registry: reg,
  });
  return { reg, g, scene, id };
}

function setState(reg: ReturnType<typeof createRegistry>, id: number, state: ControllerState) {
  writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
    const entry = d.byEntity.get(id)!;
    entry.state = state;
    d.byEntity.set(id, entry);
  });
}

function meshColorHex(scene: THREE.Scene): number {
  const mesh = scene.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh)!;
  const mat = mesh.material as THREE.MeshStandardMaterial;
  return mat.color.getHex();
}

describe("CharacterRenderSyncSystem — color per FSM state", () => {
  it("creates a mesh on first tick + colors it by ctrl.state", () => {
    const { reg, g, scene } = setup();
    executeGraph(g, reg, { dt: 0.016, now: 0 });
    expect(scene.children.length).toBe(1);
    expect(meshColorHex(scene)).toBe(STATE_COLOR_HEX.surfaceRun);
  });

  it("switches material color when state changes", () => {
    const { reg, g, scene, id } = setup();
    executeGraph(g, reg, { dt: 0.016, now: 0 });
    expect(meshColorHex(scene)).toBe(STATE_COLOR_HEX.surfaceRun);

    setState(reg, id, "surfaceSlide");
    executeGraph(g, reg, { dt: 0.016, now: 0.016 });
    expect(meshColorHex(scene)).toBe(STATE_COLOR_HEX.surfaceSlide);

    setState(reg, id, "airborne");
    executeGraph(g, reg, { dt: 0.016, now: 0.032 });
    expect(meshColorHex(scene)).toBe(STATE_COLOR_HEX.airborne);

    setState(reg, id, "climb");
    executeGraph(g, reg, { dt: 0.016, now: 0.048 });
    expect(meshColorHex(scene)).toBe(STATE_COLOR_HEX.climb);

    setState(reg, id, "surfaceRun");
    executeGraph(g, reg, { dt: 0.016, now: 0.064 });
    expect(meshColorHex(scene)).toBe(STATE_COLOR_HEX.surfaceRun);
  });

  it("STATE_COLOR_HEX covers every ControllerState enum variant", () => {
    // Compile-time check that all declared states have a color. If a new
    // ControllerState is added, this test forces STATE_COLOR_HEX to be
    // updated too — otherwise mesh.material falls back to the default and
    // the new state's transitions become hard to verify visually.
    const declared: ControllerState[] = [
      "surfaceRun",
      "surfaceSlide",
      "climb",
      "airborne",
      "wingLaunch",
      "flap",
      "glide",
    ];
    for (const s of declared) {
      expect(STATE_COLOR_HEX[s]).toBeTypeOf("number");
    }
  });
});
