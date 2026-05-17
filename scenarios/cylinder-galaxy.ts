/**
 * Test: Mario-Galaxy-style horizontal cylinder. Gravity pulls radially toward
 * the cylinder's axis everywhere, so the character can walk all the way
 * around the OUTSIDE of the log and stay glued to the surface — the camera
 * stays "above" the player in the local-gravity frame, never sign-flipping.
 *
 * Convex cylinder (axis +X, R=10m, H=40m). A `radial` gravity field declared
 * over the volume enclosing the cylinder makes gravity always point inward
 * (toward the axis), magnitude 9.81 m/s². The character spawns on top
 * (uv=(0, 0.5)) and walks forward (KeyW at cameraYaw=π → world +Z), which
 * carries them around the perimeter. Because gravity rotates with the
 * radial direction, the camera's pivot.up (gravity-up) rotates smoothly
 * too; CameraOrbit produces the Mario-Galaxy "stay above the player"
 * behaviour the new pipeline was built for.
 *
 * Validates: Phase 2 camera math (gravity-up + parallel-transport),
 * end-to-end ForceField → CharacterController → CameraPivot pipeline on a
 * non-trivial gravity field, surface curvature handling under radial
 * gravity.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { CylindricalSurfaceProvider } from "../src/world/parametricSurfaceProvider";
import type { VolumeFieldBufferData } from "../src/buffers/volumeField";
import { VOLUME_FIELD_BUFFER_ID } from "../src/buffers/volumeField";
import { writeBuffer } from "../src/runtime/buffer";
import { holdKeysGenerator, createSimulatedInputSystem } from "../src/systems/testing/simulatedInput";
import { seedPlayerOnSurface, GAMEPLAY_OUTPUT_BUFFERS, HEADLESS_GAMEPLAY_SYSTEMS } from "./_helpers";

const AXIS_ORIGIN: [number, number, number] = [0, 0, 0];
const AXIS_DIR: [number, number, number] = [1, 0, 0];
const RADIUS = 10;
const HEIGHT = 40;

export const test: BufferTest = {
  name: "cylinder-galaxy",
  description:
    "Horizontal cylinder (axis +X, R=10m, H=40m) with a radial-to-axis gravity field " +
    "wrapping it (toward axis, 9.81 m/s²). Player spawns on top (uv=(0, 0.5)), holds " +
    "KeyW for 360 ticks (~6s), walking around the perimeter. Camera's gravity-up tracks " +
    "the radial direction so the camera stays above the player through a full revolution.",
  inputSystem: createSimulatedInputSystem(holdKeysGenerator(["KeyW"])),
  input: {
    kind: "seed",
    fn: (reg) => {
      const provider = new CylindricalSurfaceProvider({
        id: "cylinder-galaxy",
        axisOrigin: AXIS_ORIGIN,
        axisDirection: AXIS_DIR,
        radius: RADIUS,
        height: HEIGHT,
        concave: false,
      });
      seedPlayerOnSurface(reg, provider, { uv: [0, 0.5] });
      // Radial-to-axis gravity, scoped to a cylindrical volume that comfortably
      // wraps the playable surface (radius 2× the cylinder + height covers it
      // along the axis with margin).
      writeBuffer(reg.getBuffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID), (d) => {
        d.volumes = [
          {
            shape: {
              type: "cylinder",
              axisOrigin: AXIS_ORIGIN,
              axisDirection: AXIS_DIR,
              radius: RADIUS * 2,
              halfHeight: HEIGHT,
            },
            field: {
              type: "radial",
              axisOrigin: AXIS_ORIGIN,
              axisDirection: AXIS_DIR,
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
