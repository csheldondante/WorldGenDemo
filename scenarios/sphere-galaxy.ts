/**
 * Test: Mario-Galaxy planetoid. Point-radial gravity toward the centre of a
 * sphere; the player can walk anywhere on the surface and the camera stays
 * above them in the local-gravity frame. This is the canonical Mario-Galaxy
 * test: the camera pivot.up tracks the sphere's outward normal, gravity is
 * always "down toward the planet's centre."
 *
 * Convex sphere (centre origin, R=20m). A `point`-type gravity field
 * pulling toward the centre at 9.81 m/s² is declared inside a sphere-shaped
 * gravity volume that fully encloses the planetoid. The character spawns
 * at equator longitude 0 (uv=(0, 0.5)) and holds KeyW for 360 ticks
 * (~6 s). At cameraYaw=π, world-forward is +Z, which at the spawn point
 * is tangent to the equator going east — the character walks along the
 * equator, completing a fraction of a great-circle traversal.
 *
 * Validates: point-gravity field, SphericalSurfaceProvider, and the camera
 * pivot rotating its frame as the player traverses the sphere. The body
 * also stays oriented to gravity (bodyLean's apparent-gravity solver
 * already reads gravity from volumeField).
 */
import type { BufferTest } from "../src/app/bufferTest";
import { SphericalSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import type { VolumeFieldBufferData } from "../src/buffers/volumeField";
import { VOLUME_FIELD_BUFFER_ID } from "../src/buffers/volumeField";
import { writeBuffer } from "../src/runtime/buffer";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

const CENTER: [number, number, number] = [0, 0, 0];
const RADIUS = 20;

export const test: BufferTest = {
  name: "sphere-galaxy",
  description:
    "Mario-Galaxy planetoid: convex sphere (R=20m) with point-gravity toward centre at " +
    "9.81 m/s². Player spawns on the equator (uv=(0, 0.5)), holds KeyW for 360 ticks " +
    "(~6s), walking east along the equator. Camera pivot.up tracks the sphere's outward " +
    "normal so the player always looks like they're standing upright on the planet.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new SphericalSurfaceProvider({
        id: "planetoid",
        center: CENTER,
        radius: RADIUS,
        concave: false,
      });
      seedPlayerOnSurface(reg, provider, { uv: [0, 0.5] });
      writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
        d.volumes = [
          {
            shape: { type: "sphere", center: CENTER, radius: RADIUS * 2 },
            field: {
              type: "point",
              center: CENTER,
              direction: "toward",
              magnitude: 9.81,
            },
            priority: 1,
          },
        ];
      });
    },
  },
  steps: [
    { kind: "tickSystems", systemIds: HEADLESS_GAMEPLAY_SYSTEMS, ticks: 360, dt: 1 / 60 },
  ],
  output: { snapshot: GAMEPLAY_OUTPUT_BUFFERS },
  backdrop: { surfaceDebugMesh: true, surfaceMeshResolution: 48, axisGizmo: true },
};
