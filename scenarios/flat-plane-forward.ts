/**
 * Scenario: character runs forward on a flat 200×200m plane at full stick for
 * 3 seconds. Surface-frame physics regression baseline — converges to
 * desiredRunSpeed and walks along the camera-forward axis without drift.
 *
 * Captures position + velocity + locomotion mode + surface UV.
 */
import type { ScenarioDescriptor } from "../src/lib/testing/scenarioHarness";
import type { Registry } from "../src/runtime/registry";
import { createRegistry } from "../src/runtime/registry";
import { writeBuffer, readBuffer } from "../src/runtime/buffer";
import { buildExecutionGraph } from "../src/runtime/graph";
import { registerCoreBuffers } from "../src/buffers";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../src/buffers/characterController";
import { CHARACTER_INPUT_BUFFER_ID, type CharacterInputBufferData, emptyInput } from "../src/buffers/characterInput";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../src/buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../src/buffers/velocity";
import { SURFACE_ATTACHMENT_BUFFER_ID, type SurfaceAttachmentBufferData } from "../src/buffers/surfaceAttachment";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../src/buffers/surfaceProvider";
import { DEFAULT_PLAYER_PROFILE } from "../src/buffers/characterControllerProfile";
import { createCharacterControllerSystem } from "../src/systems/characterController";
import { createForceFieldSystem } from "../src/systems/forceField";
import { createSurfaceConstrainedVelocitySystem } from "../src/systems/surfaceConstrainedVelocity";
import { createVolumetricConstrainedVelocitySystem } from "../src/systems/volumetricConstrainedVelocity";
import { createSurfaceConstraintSystem } from "../src/systems/surfaceConstraint";
import { createTangentInputMapperSystem } from "../src/systems/tangentInputMapper";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";

const PLAYER = 1;

export const scenario: ScenarioDescriptor = {
  name: "flat-plane-forward",
  description:
    "200×200m flat plane. Character spawns at the center, cameraYaw=π (forward = +Z). " +
    "Holds moveY=1 (forward) for 180 ticks at dt=0.0167 ≈ 3 seconds. Verifies the surface-" +
    "frame solver converges to desiredRunSpeed along Ft with no lateral drift.",
  dt: 1 / 60,
  durationTicks: 180,
  envelopePad: 0.1,
  build(reg: Registry) {
    registerCoreBuffers(reg);
    reg.registerSystem(createForceFieldSystem());
    reg.registerSystem(createTangentInputMapperSystem());
    reg.registerSystem(createCharacterControllerSystem());
    reg.registerSystem(createSurfaceConstrainedVelocitySystem());
    reg.registerSystem(createVolumetricConstrainedVelocitySystem());
    reg.registerSystem(createSurfaceConstraintSystem());

    // 200×200m plane centered at world origin, on the y=0 surface; tangentU=+X, tangentV=−Z.
    const PATCH = 200;
    const provider = new PlaneSurfaceProvider({
      id: "flat",
      origin: [-PATCH / 2, 0, PATCH / 2],
      extentU: [PATCH, 0, 0],
      extentV: [0, 0, -PATCH],
      friction: 1,
      normalInMax: 800,
      normalOutMax: 200,
    });
    const sample = provider.sampleAtUV(0.5, 0.5);
    const radius = DEFAULT_PLAYER_PROFILE.bodyRadius;

    writeBuffer(reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID), (d) => {
      d.heightmap = provider;
    });
    writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
      d.byEntity.set(PLAYER, {
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
      });
    });
    writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
      d.byEntity.set(PLAYER, emptyInput(Math.PI)); // cameraYaw=π → forward=+Z
    });
    writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
      d.byEntity.set(PLAYER, {
        position: [
          sample.position[0] + sample.normal[0] * radius,
          sample.position[1] + sample.normal[1] * radius,
          sample.position[2] + sample.normal[2] * radius,
        ],
        yaw: 0,
        scale: 1,
      });
    });
    writeBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID), (d) => {
      d.byEntity.set(PLAYER, { linear: [0, 0, 0], prevLinear: [0, 0, 0] });
    });
    writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
      d.byEntity.set(PLAYER, {
        surfaceId: provider.id,
        uv: [0.5, 0.5],
        offsetAlongNormal: radius,
        sample,
      });
    });

    const graph = buildExecutionGraph({
      id: "flat-plane-forward",
      nodes: [
        "forceFieldSystem",
        "tangentInputMapperSystem",
        "characterControllerSystem",
        "surfaceConstrainedVelocitySystem",
        "volumetricConstrainedVelocitySystem",
        "surfaceConstraintSystem",
      ],
      registry: reg,
    });

    return { graph, entityIds: { player: PLAYER } };
  },
  input: [
    // Hold forward from tick 0 onward.
    { tick: 0, moveAxis: { x: 0, y: 1 } },
  ],
  channels: [
    { name: "pos.x", kind: "numeric", sample: (reg, ctx) =>
        readBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID)).byEntity.get(ctx.entityIds.player)!.position[0],
    },
    { name: "pos.y", kind: "numeric", sample: (reg, ctx) =>
        readBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID)).byEntity.get(ctx.entityIds.player)!.position[1],
    },
    { name: "pos.z", kind: "numeric", sample: (reg, ctx) =>
        readBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID)).byEntity.get(ctx.entityIds.player)!.position[2],
    },
    { name: "vel.x", kind: "numeric", sample: (reg, ctx) =>
        readBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID)).byEntity.get(ctx.entityIds.player)!.linear[0],
    },
    { name: "vel.z", kind: "numeric", sample: (reg, ctx) =>
        readBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID)).byEntity.get(ctx.entityIds.player)!.linear[2],
    },
    { name: "locomotionMode", kind: "categorical", sample: (reg, ctx) =>
        readBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID)).byEntity.get(ctx.entityIds.player)!.locomotionMode,
    },
  ],
};

/**
 * Apply a scenario input event to the runtime input buffers. The scenario
 * format is independent of the project's input shape — this adapter knows how
 * to translate moveAxis/lookDelta/jumpPressed onto `CharacterInputBuffer`
 * (and, in future scenarios, `InputMapBuffer` for camera-look input).
 */
export function applyScenarioInput(reg: Registry, event: {
  tick: number;
  moveAxis?: { x: number; y: number };
  lookDelta?: { yaw: number; pitch: number };
  jumpPressed?: boolean;
} | null): void {
  if (!event) return;
  const ciBuf = reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID);
  const prev = readBuffer(ciBuf).byEntity.get(PLAYER);
  if (!prev) return;
  writeBuffer(ciBuf, (d) => {
    d.byEntity.set(PLAYER, {
      ...prev,
      moveX: event.moveAxis?.x ?? prev.moveX,
      moveY: event.moveAxis?.y ?? prev.moveY,
      jumpPressed: event.jumpPressed ?? false,
      jumpReleased: false,
      jumpHeld: event.jumpPressed ?? prev.jumpHeld,
      jumpHoldSec: prev.jumpHoldSec,
      cameraYaw: prev.cameraYaw,
    });
  });
  // lookDelta would feed InputMapBuffer.lookDelta for camera scenarios.
  // Not used by this scenario (no camera scrubbing); left as TODO when the
  // first camera scenario lands.
}
