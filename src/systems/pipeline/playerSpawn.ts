import { readBuffer, writeBuffer } from "../../runtime/buffer";
import type { SystemDescriptor } from "../../runtime/system";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../buffers/worldData";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../../buffers/surfaceProvider";
import { STATE_MACHINE_BUFFER_ID } from "../../buffers/stateMachine";
import { TIMING_BUFFER_ID } from "../../buffers/timing";
import { ENTITY_BUFFER_ID, type EntityBufferData, spawnEntity } from "../../buffers/entity";
import { TRANSFORM_BUFFER_ID } from "../../buffers/transform";
import { VELOCITY_BUFFER_ID } from "../../buffers/velocity";
import { FORCE_ACCUMULATOR_BUFFER_ID } from "../../buffers/forceAccumulator";
import { SPHERE_BODY_BUFFER_ID } from "../../buffers/sphereBody";
import { CHARACTER_CONTROLLER_BUFFER_ID } from "../../buffers/characterController";
import { CHARACTER_INPUT_BUFFER_ID, emptyInput } from "../../buffers/characterInput";
import { CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, type CharacterControllerProfileBufferData, DEFAULT_PLAYER_PROFILE } from "../../buffers/characterControllerProfile";
import { SURFACE_ATTACHMENT_BUFFER_ID } from "../../buffers/surfaceAttachment";
import { RIG_DEFINITION_BUFFER_ID, type RigDefinitionBufferData } from "../../buffers/rigDefinition";
import { SKELETON_BUFFER_ID, initSkeletonFromRig } from "../../buffers/skeleton";
import { assertDev } from "../../runtime/dev";
import { STATE_MACHINE_SYSTEM_ID } from "../../runtime/stateMachine";
import { SURFACE_PROVIDER_SYSTEM_ID } from "./surfaceProvider";
import { runOncePerRebuild } from "./common";

export const PLAYER_SPAWN_SYSTEM_ID = "playerSpawnSystem";

/**
 * Spawn the player entity on first rebuild. Subsequent rebuilds re-attach the
 * existing player to the new surface (snap to a sensible spawn UV).
 *
 * Spawn point: south edge of the heightmap, looking north. UV (0.5, 0.95).
 */
export function createPlayerSpawnSystem(): SystemDescriptor {
  const state = { lastGen: -1 };
  let playerId: number | null = null;
  return {
    id: PLAYER_SPAWN_SYSTEM_ID,
    description:
      "Spawns the player entity on first rebuild and re-attaches to the new heightmap on subsequent rebuilds. Sets transform from a south-edge spawn UV.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: ENTITY_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
      { id: SPHERE_BODY_BUFFER_ID, access: "readwrite" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "readwrite" },
      { id: CHARACTER_INPUT_BUFFER_ID, access: "readwrite" },
      { id: CHARACTER_CONTROLLER_PROFILE_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "readwrite" },
      { id: RIG_DEFINITION_BUFFER_ID, access: "read" },
      { id: SKELETON_BUFFER_ID, access: "readwrite" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [SURFACE_PROVIDER_SYSTEM_ID, STATE_MACHINE_SYSTEM_ID],
    execute: (ctx) => {
      runOncePerRebuild({
        ctx,
        state,
        stageName: "playerSpawn",
        body: () => {
          const world = readBuffer(ctx.buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
          const surfaceProvider = readBuffer(ctx.buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID));
          if (!world.heightmap || !surfaceProvider.heightmap) return;
          const profileBuf = readBuffer(ctx.buffer<CharacterControllerProfileBufferData>(CHARACTER_CONTROLLER_PROFILE_BUFFER_ID));
          const profile = profileBuf.byId.get(DEFAULT_PLAYER_PROFILE.id) ?? DEFAULT_PLAYER_PROFILE;

          const spawnUV: [number, number] = [0.5, 0.92]; // south, slightly inset
          const sample = surfaceProvider.heightmap.sampleAtUV(spawnUV[0], spawnUV[1]);
          const spawnPos: [number, number, number] = [
            sample.position[0],
            sample.position[1] + profile.bodyRadius,
            sample.position[2],
          ];

          const entityBuf = ctx.buffer<EntityBufferData>(ENTITY_BUFFER_ID);
          let id: number;
          if (playerId === null) {
            writeBuffer(entityBuf, (d) => {
              id = spawnEntity(d);
              playerId = id;
            });
          } else {
            id = playerId;
          }

          const setComponent = <T>(bufId: string, component: T, key: "byEntity" | "byId" = "byEntity") => {
            const buf = ctx.buffer<{ [k: string]: Map<number, T> }>(bufId);
            writeBuffer(buf, (d) => { d[key].set(playerId!, component); });
          };

          setComponent(TRANSFORM_BUFFER_ID, { position: spawnPos, yaw: 0, scale: 1 });
          setComponent(VELOCITY_BUFFER_ID, { linear: [0, 0, 0] as [number, number, number] });
          setComponent(FORCE_ACCUMULATOR_BUFFER_ID, { accel: [0, 0, 0] as [number, number, number] });
          setComponent(SPHERE_BODY_BUFFER_ID, { radius: profile.bodyRadius });
          setComponent(CHARACTER_CONTROLLER_BUFFER_ID, {
            state: "surfaceRun" as const,
            locomotionMode: "surfaceConstrained" as const,
            profileId: profile.id,
            lastTransitionReason: "spawn",
            timeInState: 0,
            orientation: {
              current: [0, 0, 0, 1] as [number, number, number, number],
              target: [0, 0, 0, 1] as [number, number, number, number],
            },
          });
          setComponent(CHARACTER_INPUT_BUFFER_ID, emptyInput(0));
          setComponent(SURFACE_ATTACHMENT_BUFFER_ID, {
            surfaceId: surfaceProvider.heightmap.id,
            uv: spawnUV,
            offsetAlongNormal: profile.bodyRadius,
            sample,
          });

          const bipedRig = readBuffer(ctx.buffer<RigDefinitionBufferData>(RIG_DEFINITION_BUFFER_ID)).byId.get("biped");
          assertDev(!!bipedRig, "playerSpawn: default 'biped' rig missing from RigDefinitionBuffer");
          if (bipedRig) setComponent(SKELETON_BUFFER_ID, initSkeletonFromRig(bipedRig));

          // Mark warning so HUD knows the player spawned
          // (lighter than emitting an event).
          // eslint-disable-next-line no-console
          console.log(`[player] spawned at world ${spawnPos.map((n) => n.toFixed(2)).join(", ")} uv ${spawnUV}`);
        },
      });
    },
  };
}
