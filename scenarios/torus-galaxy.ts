/**
 * Test: Mario-Galaxy torus. Circle-radial gravity pulls every point on or
 * near the torus toward the nearest point on the major-radius spine, so a
 * character on the donut surface stays glued whichever side of the tube
 * they're on. Walking forward along the major direction carries them
 * around the donut hole; the camera frame rotates around the spine
 * along with them.
 *
 * Convex torus (centre origin, axis +Y, R=18m major, r=4m minor). The
 * `circle`-type gravity field has the same axis and majorRadius as the
 * torus, magnitude 9.81 m/s², direction "toward". An AABB-shaped gravity
 * volume comfortably enclosing the torus (R+r in both x/z, r in y)
 * scopes the field. Player spawns at outer-equator (uv=(0, 0.25): u=0 →
 * +X side of major radius, v=0.25 → top of tube) and holds KeyW for 360
 * ticks (~6s), travelling along the major direction.
 *
 * Validates: circle-gravity field, the existing TorusSurfaceProvider, and
 * camera/body orientation under a gravity field where "down" is "toward
 * the spine" — a continuously rotating direction as you traverse the donut.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { TorusSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import type { VolumeFieldBufferData } from "../src/buffers/volumeField";
import { VOLUME_FIELD_BUFFER_ID } from "../src/buffers/volumeField";
import { writeBuffer } from "../src/runtime/buffer";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

const CENTER: [number, number, number] = [0, 0, 0];
const AXIS_DIR: [number, number, number] = [0, 1, 0];
const MAJOR_RADIUS = 18;
const MINOR_RADIUS = 4;

export const test: BufferTest = {
  name: "torus-galaxy",
  description:
    "Mario-Galaxy donut: convex torus (R=18m, r=4m, axis +Y) with circle-gravity " +
    "toward the major-radius spine at 9.81 m/s². Player spawns on top of the tube " +
    "(uv=(0, 0.25)), holds KeyW for 360 ticks (~6s), travelling along the major " +
    "direction (around the donut hole). Camera pivot.up tracks the tube's outward " +
    "normal so the player walks 'upright' along the donut top.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new TorusSurfaceProvider({
        id: "torus-galaxy",
        center: CENTER,
        axisDirection: AXIS_DIR,
        majorRadius: MAJOR_RADIUS,
        minorRadius: MINOR_RADIUS,
        concave: false,
      });
      seedPlayerOnSurface(reg, provider, { uv: [0, 0.25] });
      const bound = MAJOR_RADIUS + MINOR_RADIUS + 5;
      writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
        d.volumes = [
          {
            shape: {
              type: "aabb",
              min: [-bound, -MINOR_RADIUS - 5, -bound],
              max: [bound, MINOR_RADIUS + 5, bound],
            },
            field: {
              type: "circle",
              axisOrigin: CENTER,
              axisDirection: AXIS_DIR,
              majorRadius: MAJOR_RADIUS,
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
