/**
 * Simulated input source — drop-in for `inputSystem` (id = `INPUT_SYSTEM_ID`).
 * Generates input programmatically rather than reading from a recorded
 * timeline. Use for stress / fuzz tests: random-walk move axes + jump pulses,
 * holding-forward, scripted action sequences, etc.
 *
 * Common patterns are pre-shipped as `simulatedInputXxx` factories below; new
 * patterns plug in via `createSimulatedInputSystem(generator)`. The generator
 * receives the current tick and returns a partial input snapshot (sticky keys
 * are not auto-carried — the generator owns the full state each frame, which
 * matches how programmatic scenarios think about input).
 */
import type { SystemDescriptor } from "../../runtime/system";
import { writeBuffer } from "../../runtime/buffer";
import { INPUT_BUFFER_ID, type InputBufferData } from "../../buffers/input";
import { SCRIPTED_INPUT_SYSTEM_ID } from "../input";

export interface SimulatedInputSample {
  keys?: Set<string>;
  mouseDx?: number;
  mouseDy?: number;
  pointerLocked?: boolean;
  gamepadConnected?: boolean;
  gamepadAxes?: { leftX: number; leftY: number; rightX: number; rightY: number };
  gamepadButtons?: Set<string>;
}

/**
 * Per-tick generator. `tick` starts at 0 and increments every frame the system
 * runs. Returning `undefined` for a field means "leave InputBuffer's value
 * unchanged this frame" — but typical generators return a full snapshot.
 */
export type SimulatedInputGenerator = (tick: number) => SimulatedInputSample;

/**
 * Build a simulated input system from a per-tick generator. The system OWNS
 * the InputBuffer write each tick — fields not set by the generator get
 * cleared (mouseDx/Dy default 0; sets default empty). If you need sticky
 * carry-over, do that inside the generator.
 */
export function createSimulatedInputSystem(generator: SimulatedInputGenerator): SystemDescriptor {
  let cursor = 0;
  return {
    id: SCRIPTED_INPUT_SYSTEM_ID,
    description:
      "Programmatic input source for tests/stress. Sibling of inputSystem under the SCRIPTED_INPUT_SYSTEM_ID slot: a per-tick generator function decides what to write into InputBuffer. Used for random-walk fuzz tests, hold-forward smoke tests, and scripted action chains that aren't worth pre-recording. The active mode's `systems` list selects between this and the live inputSystem.",
    buffers: [{ id: INPUT_BUFFER_ID, access: "readwrite" }],
    execute: ({ buffer }) => {
      const sample = generator(cursor);
      writeBuffer(buffer<InputBufferData>(INPUT_BUFFER_ID), (d) => {
        d.keys = sample.keys ? new Set(sample.keys) : new Set();
        d.mouseDx = sample.mouseDx ?? 0;
        d.mouseDy = sample.mouseDy ?? 0;
        d.pointerLocked = sample.pointerLocked ?? false;
        d.gamepadConnected = sample.gamepadConnected ?? false;
        d.gamepadAxes = sample.gamepadAxes ?? { leftX: 0, leftY: 0, rightX: 0, rightY: 0 };
        d.gamepadButtons = sample.gamepadButtons ? new Set(sample.gamepadButtons) : new Set();
      });
      cursor += 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Common pre-built generators
// ---------------------------------------------------------------------------

/** Hold a fixed set of keys for every frame. Useful for "run forward forever" smoke. */
export function holdKeysGenerator(keys: string[]): SimulatedInputGenerator {
  const heldKeys = new Set(keys);
  return () => ({ keys: heldKeys });
}

/**
 * Random-walk move axes via the left-stick analog channel. Each tick the
 * generator nudges leftX/leftY by a small delta (Gaussian-ish from a seeded
 * RNG) and clamps to [-1, 1]. With `jumpEveryN` set, drops a `GamepadA`
 * button-down on a periodic cadence.
 *
 * Use for fuzzing the controller against many character configurations or
 * spawned agents — the original use case is the energy-invariant stress test.
 */
export interface RandomWalkOptions {
  seed?: number;
  /** Stddev of per-tick axis nudge. Default 0.08 → typical drift across a second. */
  axisStep?: number;
  /** If set, press GamepadA every `jumpEveryN` ticks. Default disabled (never jumps). */
  jumpEveryN?: number;
}

export function randomWalkGenerator(opts: RandomWalkOptions = {}): SimulatedInputGenerator {
  const axisStep = opts.axisStep ?? 0.08;
  const jumpEveryN = opts.jumpEveryN;
  // Mulberry32 — small, deterministic, good enough for stress.
  let s = (opts.seed ?? 0xC0FFEE) >>> 0;
  function rng(): number {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function gauss(): number {
    // Box-Muller; one call returns one sample.
    const u = Math.max(rng(), 1e-9);
    const v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  let lx = 0, ly = 0;
  const buttons = new Set<string>();
  return (tick) => {
    lx = Math.max(-1, Math.min(1, lx + gauss() * axisStep));
    ly = Math.max(-1, Math.min(1, ly + gauss() * axisStep));
    if (jumpEveryN !== undefined && tick > 0 && tick % jumpEveryN === 0) {
      buttons.clear();
      buttons.add("GamepadA");
    } else {
      buttons.clear();
    }
    return {
      gamepadConnected: true,
      gamepadAxes: { leftX: lx, leftY: ly, rightX: 0, rightY: 0 },
      gamepadButtons: buttons,
    };
  };
}
