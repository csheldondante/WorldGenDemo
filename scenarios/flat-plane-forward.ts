/**
 * Scenario: hold "forward" on a flat plane for 3 seconds. Bootstraps the
 * REAL runtime (`bootstrapApp` with `inputSource: simulated`), seeds a
 * synthetic plane + player, forces SM to Running, ticks the production
 * Running graph and captures channels.
 *
 * The only thing different from a real game session: input comes from a
 * deterministic `holdKeysGenerator(["KeyW"])` instead of a player's keyboard.
 * Every other system in the Running graph runs exactly as in production.
 */
import type { ScenarioDescriptor } from "../src/lib/testing/scenarioHarness";
import type { Registry } from "../src/runtime/registry";
import { writeBuffer, readBuffer } from "../src/runtime/buffer";
import { CHARACTER_CONTROLLER_BUFFER_ID, type CharacterControllerBufferData } from "../src/buffers/characterController";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../src/buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../src/buffers/velocity";
import { SURFACE_ATTACHMENT_BUFFER_ID, type SurfaceAttachmentBufferData } from "../src/buffers/surfaceAttachment";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../src/buffers/surfaceProvider";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../src/buffers/stateMachine";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../src/buffers/camera";
import { ENTITY_BUFFER_ID, type EntityBufferData, spawnEntity } from "../src/buffers/entity";
import { CHARACTER_INPUT_BUFFER_ID, type CharacterInputBufferData, emptyInput } from "../src/buffers/characterInput";
import { SPHERE_BODY_BUFFER_ID, type SphereBodyBufferData } from "../src/buffers/sphereBody";
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../src/buffers/forceAccumulator";
import { DEFAULT_PLAYER_PROFILE } from "../src/buffers/characterControllerProfile";
import { PlaneSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import { holdKeysGenerator } from "../src/systems/testing/simulatedInput";

export const scenario: ScenarioDescriptor = {
  name: "flat-plane-forward",
  description:
    "200×200m flat plane. Player holds KeyW for 180 ticks (~3s at 60Hz). Drives " +
    "the REAL Running graph via simulated input. Verifies the full input → mapper → " +
    "controller → integrator → constraint pipeline produces convergent forward speed " +
    "with no lateral or vertical drift.",
  dt: 1 / 60,
  durationTicks: 180,
  envelopePad: 0.1,
  inputSource: {
    kind: "simulated",
    generator: holdKeysGenerator(["KeyW"]),
  },
  seed(reg: Registry) {
    // Force SM to Running so the real Running graph drives every tick.
    writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
      d.state = "Running";
      d.activeGraph = "Running";
      d.pendingEvents = [];
      d.pendingLoad = null;
      d.pendingRebuild = null;
    });

    // Seed camera yaw = π so KeyW (forward) projects onto +Z on the tangent
    // plane. tangentInputMapperSystem builds Fw from cam.yaw via the real
    // pipeline: (-sin yaw, 0, -cos yaw). At yaw=π → Fw = (0, 0, +1).
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.yaw = Math.PI;
      d.pitch = 0;
    });

    // Synthetic 200×200m plane centered at world origin. tangentU=+X, tangentV=−Z;
    // surface normal = +Y; uv (0.5, 0.5) → world (0, 0, 0).
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

    // Spawn one player entity.
    let playerId = -1;
    writeBuffer(reg.getBuffer<EntityBufferData>(ENTITY_BUFFER_ID), (d) => {
      playerId = spawnEntity(d);
    });

    writeBuffer(reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID), (d) => {
      d.byEntity.set(playerId, {
        position: [
          sample.position[0] + sample.normal[0] * radius,
          sample.position[1] + sample.normal[1] * radius,
          sample.position[2] + sample.normal[2] * radius,
        ],
        yaw: Math.PI, // facing +Z so KeyW drives the player forward
        scale: 1,
      });
    });
    writeBuffer(reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID), (d) => {
      d.byEntity.set(playerId, { linear: [0, 0, 0], prevLinear: [0, 0, 0] });
    });
    writeBuffer(reg.getBuffer<SphereBodyBufferData>(SPHERE_BODY_BUFFER_ID), (d) => {
      d.byEntity.set(playerId, { radius });
    });
    writeBuffer(reg.getBuffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID), (d) => {
      d.byEntity.set(playerId, { accel: [0, 0, 0] });
    });
    writeBuffer(reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID), (d) => {
      d.byEntity.set(playerId, {
        state: "surfaceRun",
        locomotionMode: "surfaceConstrained",
        profileId: DEFAULT_PLAYER_PROFILE.id,
        lastTransitionReason: "spawn",
        transitions: [],
        timeInState: 0,
        yawVel: 0,
        targetYaw: Math.PI,
        bodyUpCurrent: [0, 0, 0, 1],
        bodyUpWorld: [0, 1, 0],
        orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      });
    });
    writeBuffer(reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID), (d) => {
      d.byEntity.set(playerId, emptyInput(Math.PI));
    });
    writeBuffer(reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID), (d) => {
      d.byEntity.set(playerId, {
        surfaceId: provider.id,
        uv: [0.5, 0.5],
        offsetAlongNormal: radius,
        sample,
      });
    });

    return { entityIds: { player: playerId } };
  },
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
    { name: "activeGraph", kind: "categorical", sample: (_reg, ctx) => ctx.activeGraph },
  ],
};
