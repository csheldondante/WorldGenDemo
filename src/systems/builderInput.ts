import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { BUILDER_BUFFER_ID } from "../buffers/builder";
import type { PaletteEntry } from "../buffers/builder";

export const BUILDER_INPUT_SYSTEM_ID = "builderInputSystem";

/**
 * Events emitted by DOM handlers, drained per tick by BuilderSystem.
 *
 * (Defined here, applied in `src/systems/builder.ts`. The split keeps the
 * DOM-attachment surface and the buffer-mutation surface in separate files.)
 */
export type BuilderEvent =
  | { type: "PaintStrokeBegin"; x: number; y: number }
  | { type: "PaintStrokeMove"; x: number; y: number }
  | { type: "PaintStrokeEnd" }
  | { type: "FloodFill"; x: number; y: number }
  | { type: "Undo" }
  | { type: "Redo" }
  | { type: "PaletteSelect"; id: string }
  | { type: "PaletteAdd"; id: string }
  | { type: "PaletteRemove"; id: string }
  | { type: "PaletteRecolor"; id: string; color: string }
  | { type: "BrushSizeSet"; size: 1 | 3 | 7 }
  | { type: "BrushToolSet"; tool: "paint" | "fill" }
  | { type: "SendToWorld" };

/** Mutable accumulator the DOM handlers append to. Drained by the system. */
export interface BuilderInputAccumulator {
  events: BuilderEvent[];
}

export function createBuilderAccumulator(): BuilderInputAccumulator {
  return { events: [] };
}

/**
 * Wire DOM listeners that push BuilderEvents into the accumulator. Called once
 * by the app shell after the editor DOM exists. Each handler is wrapped to
 * push a single event; brush-down/up state lives in the closure here.
 *
 * Phase 3 will fill this in with the actual paint canvas + palette UI handlers.
 * For now we expose only the function surface; the DOM wiring happens when
 * the editor UI lands.
 */
export interface BuilderAttachOptions {
  paintCanvas: HTMLCanvasElement;
  paletteListEl: HTMLElement;
  toolbarEl: HTMLElement;
  /** Emit a `ModeRequested({mode:"world"})` to leave the builder. */
  onLeave?: () => void;
}

export function createBuilderInputSystem(_acc: BuilderInputAccumulator): SystemDescriptor {
  // The system itself is a no-op — it exists so the Builder graph has an event
  // pump system named in the topology. The accumulator is mutated by DOM
  // handlers; BuilderSystem drains it. We intentionally do not move events
  // through this system per-tick because BuilderSystem reads the accumulator
  // directly. Keeping the system in the graph documents "DOM events flow into
  // the builder here" without moving data twice.
  return {
    id: BUILDER_INPUT_SYSTEM_ID,
    description: "Placeholder for the DOM-event pump that feeds BuilderSystem. No buffer access.",
    buffers: [],
    runsAfter: [STATE_MACHINE_SYSTEM_ID],
    execute: () => { /* no-op; DOM handlers append directly to accumulator */ },
  };
}

// Used by `src/systems/builder.ts`. Re-exported so PaletteEntry can be imported
// here too without a hop, since the event types reference colors and ids.
export type { PaletteEntry };
export { BUILDER_BUFFER_ID };
