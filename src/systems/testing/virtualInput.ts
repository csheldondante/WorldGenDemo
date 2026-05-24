/**
 * Virtual input system for tests. Drop-in replacement for `inputSystem` (same
 * `id`) that copies a programmable state object into `InputBuffer` each tick
 * instead of reading the DOM / gamepad. Downstream systems (inputMapperSystem,
 * characterInputSystem) run unchanged, so tests can exercise the full real
 * input pipeline against scripted device state.
 *
 * Usage in a test:
 *
 *   const vi = createVirtualInput();
 *   reg.registerSystem(createVirtualInputSystem(vi));
 *   reg.registerSystem(createInputMapperSystem());
 *   reg.registerSystem(createCharacterInputSystem());
 *   reg.registerSystem(createCharacterControllerSystem());
 *   // ... etc ...
 *
 *   vi.keys.add("KeyW");
 *   tick(); // moves forward via the full pipeline
 *   vi.keys.delete("KeyW");
 *   vi.keys.add("KeyM");
 *   tick(); // simulates pressing M
 *
 * Mouse deltas behave like the real system: written into InputBuffer this tick,
 * the virtual state's mouseDx/mouseDy are cleared after copy so a single
 * one-tick delta doesn't accumulate.
 *
 * Buttons (keys, gamepadButtons) are held until the caller removes them — matches
 * the real input pipeline's edge-detection contract (inputMapper sees the held
 * state and turns it into pressed/released edges).
 */
import type { SystemDescriptor } from "../../runtime/system";
import { writeBuffer } from "../../runtime/buffer";
import { INPUT_BUFFER_ID, type InputBufferData } from "../../buffers/input";
import { SCRIPTED_INPUT_SYSTEM_ID } from "../input";

export interface VirtualInputState {
  keys: Set<string>;
  mouseDx: number;
  mouseDy: number;
  pointerLocked: boolean;
  gamepadConnected: boolean;
  gamepadAxes: { leftX: number; leftY: number; rightX: number; rightY: number };
  gamepadButtons: Set<string>;
}

export function createVirtualInput(): VirtualInputState {
  return {
    keys: new Set(),
    mouseDx: 0,
    mouseDy: 0,
    pointerLocked: false,
    gamepadConnected: false,
    gamepadAxes: { leftX: 0, leftY: 0, rightX: 0, rightY: 0 },
    gamepadButtons: new Set(),
  };
}

/**
 * Creates a SystemDescriptor with id = INPUT_SYSTEM_ID (the same id as the real
 * inputSystem). Registers in place of the real one — graph orderings and
 * downstream readers see no difference. Each tick copies `state` into
 * InputBuffer; mouseDx/mouseDy are zeroed after copy to model per-tick deltas.
 */
export function createVirtualInputSystem(state: VirtualInputState): SystemDescriptor {
  return {
    id: SCRIPTED_INPUT_SYSTEM_ID,
    description:
      "Test virtual input source. Sibling of inputSystem under SCRIPTED_INPUT_SYSTEM_ID: copies a programmable VirtualInputState into InputBuffer each tick instead of polling DOM/gamepad. Mouse deltas are one-shot per tick (cleared from the state after copy).",
    buffers: [{ id: INPUT_BUFFER_ID, access: "readwrite" }],
    execute: ({ buffer }) => {
      writeBuffer(buffer<InputBufferData>(INPUT_BUFFER_ID), (d) => {
        d.keys = new Set(state.keys);
        d.mouseDx = state.mouseDx;
        d.mouseDy = state.mouseDy;
        d.pointerLocked = state.pointerLocked;
        d.gamepadConnected = state.gamepadConnected;
        d.gamepadAxes = { ...state.gamepadAxes };
        d.gamepadButtons = new Set(state.gamepadButtons);
      });
      state.mouseDx = 0;
      state.mouseDy = 0;
    },
  };
}
