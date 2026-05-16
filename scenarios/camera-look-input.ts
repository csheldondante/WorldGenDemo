/**
 * Test: mouse-look input → camera yaw + pitch evolves correctly.
 *
 * Drives mouseDx/mouseDy on every tick via a simulated-input generator so the
 * full input pipeline (InputSystem → InputMapperSystem → CameraFollowSystem)
 * runs unchanged. After 120 ticks the camera should have:
 *   - rotated yaw by `total_mouseDx · MOUSE_SENS` (negative — mouse-right
 *     decreases yaw by inputMapper convention).
 *   - rotated pitch correspondingly; both clamped at PITCH_LIMIT.
 *
 * Validates the input → camera contract end-to-end, isolating from gameplay
 * physics (no player entity, no SurfaceProvider — character systems are
 * excluded from the step's systemIds; only the input + camera chain runs).
 */
import type { BufferTest } from "../src/app/bufferTest";
import { writeBuffer } from "../src/runtime/buffer";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../src/buffers/stateMachine";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../src/buffers/camera";
import {
  createSimulatedInputSystem,
  type SimulatedInputGenerator,
} from "../src/systems/testing/simulatedInput";

/**
 * Constant mouse delta each tick: +2px/tick right, +1px/tick down.
 * Lets the test verify accumulation across 120 ticks deterministically.
 */
const mouseLookGenerator: SimulatedInputGenerator = () => ({
  pointerLocked: true,
  mouseDx: 2,
  mouseDy: 1,
});

const OUTPUT_BUFFERS = [
  "input",
  "inputMap",
  "camera",
  "stateMachine",
];

/**
 * Only the input + camera-follow chain. No character systems because we don't
 * spawn a player entity. This isolates the camera contract from the rest of
 * the runtime — a regression in cameraFollow shows up here without noise
 * from the controller pipeline.
 */
const INPUT_CAMERA_CHAIN = [
  "stateMachineSystem",
  "inputSystem",
  "inputMapperSystem",
  "cameraFollowSystem",
];

export const test: BufferTest = {
  name: "camera-look-input",
  description:
    "120 ticks of constant mouse delta (+2px right, +1px down per tick) into the real " +
    "InputSystem → InputMapperSystem → CameraFollowSystem chain. Verifies look-delta " +
    "accumulates into camera.yaw / camera.pitch correctly (and pitch is clamped at the " +
    "PITCH_LIMIT). Isolated from gameplay physics — no player entity, no surface.",
  inputSystem: createSimulatedInputSystem(mouseLookGenerator),
  input: {
    kind: "seed",
    fn: (reg) => {
      writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
        d.state = "Running";
        d.activeGraph = "Running";
        d.pendingEvents = [];
        d.pendingLoad = null;
        d.pendingRebuild = null;
      });
      writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
        d.yaw = 0;
        d.pitch = 0;
        d.pos = [0, 0, 0];
      });
    },
  },
  steps: [
    {
      kind: "tickSystems",
      systemIds: INPUT_CAMERA_CHAIN,
      ticks: 120,
      dt: 1 / 60,
    },
  ],
  output: {
    snapshot: OUTPUT_BUFFERS,
  },
};
