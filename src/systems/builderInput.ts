import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { BUILDER_BUFFER_ID } from "../buffers/builder";
import type { PaletteEntry } from "../buffers/builder";

export const BUILDER_INPUT_SYSTEM_ID = "builderInputSystem";

/**
 * Events emitted by DOM handlers, drained per tick by BuilderSystem.
 */
export type BuilderEvent =
  | { type: "PaintStrokeBegin"; x: number; y: number }
  | { type: "PaintStrokeMove"; x: number; y: number }
  | { type: "PaintStrokeEnd" }
  | { type: "FloodFill"; x: number; y: number }
  | { type: "Undo" }
  | { type: "Redo" }
  | { type: "PaletteSelect"; id: string }
  | { type: "PaletteAdd"; id: string; kind: "terrain" | "asset" }
  | { type: "PaletteRemove"; id: string }
  | { type: "PaletteRecolor"; id: string; color: string }
  | { type: "BrushSizeSet"; size: number }
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
 * DOM references the BuilderSystem reads and writes each tick. Populated by
 * `attachBuilderListeners` at app startup. Shared via a small mutable record
 * so the system creator and the DOM wirer can pass refs around without
 * threading them through buffer state.
 */
export interface BuilderDom {
  paintCanvas: HTMLCanvasElement | null;
  paletteListEl: HTMLElement | null;
  assetMenuEl: HTMLElement | null;
  errorEl: HTMLElement | null;
  brushSizeSel: HTMLInputElement | null;
  brushSizeValueEl: HTMLElement | null;
  paintBtn: HTMLButtonElement | null;
  fillBtn: HTMLButtonElement | null;
  undoBtn: HTMLButtonElement | null;
  redoBtn: HTMLButtonElement | null;
  sendBtn: HTMLButtonElement | null;
}

export function createBuilderDom(): BuilderDom {
  return {
    paintCanvas: null,
    paletteListEl: null,
    assetMenuEl: null,
    errorEl: null,
    brushSizeSel: null,
    brushSizeValueEl: null,
    paintBtn: null,
    fillBtn: null,
    undoBtn: null,
    redoBtn: null,
    sendBtn: null,
  };
}

export interface AttachBuilderOptions {
  panel: HTMLElement;
  acc: BuilderInputAccumulator;
  dom: BuilderDom;
}

/**
 * Wire DOM listeners on the builder panel. Pushes BuilderEvents onto the
 * accumulator. Caches DOM refs into `dom` for the system to read/update.
 *
 * Palette-row clicks and asset-menu clicks are wired dynamically by
 * BuilderSystem when it re-renders those lists (delegated event handlers
 * reset every render — fine at this scale).
 */
export function attachBuilderListeners(opts: AttachBuilderOptions): void {
  const { panel, acc, dom } = opts;

  dom.paintCanvas = panel.querySelector<HTMLCanvasElement>("#paint-canvas");
  dom.paletteListEl = panel.querySelector<HTMLElement>("#palette-list");
  dom.assetMenuEl = panel.querySelector<HTMLElement>("#asset-menu");
  dom.errorEl = panel.querySelector<HTMLElement>("#builder-error");
  dom.brushSizeSel = panel.querySelector<HTMLInputElement>("#brush-size");
  dom.brushSizeValueEl = panel.querySelector<HTMLElement>("#brush-size-value");
  dom.paintBtn = panel.querySelector<HTMLButtonElement>("#tool-paint");
  dom.fillBtn = panel.querySelector<HTMLButtonElement>("#tool-fill");
  dom.undoBtn = panel.querySelector<HTMLButtonElement>("#tool-undo");
  dom.redoBtn = panel.querySelector<HTMLButtonElement>("#tool-redo");
  dom.sendBtn = panel.querySelector<HTMLButtonElement>("#send-to-world");

  const canvas = dom.paintCanvas;
  if (canvas) {
    let painting = false;
    function eventToBitmap(e: MouseEvent): { x: number; y: number } | null {
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
      const py = ((e.clientY - rect.top) / rect.height) * canvas.height;
      return { x: Math.floor(px), y: Math.floor(py) };
    }
    canvas.addEventListener("mousedown", (e) => {
      const p = eventToBitmap(e);
      if (!p) return;
      // Emit both — BuilderSystem dispatches based on current brushTool.
      acc.events.push({ type: "PaintStrokeBegin", x: p.x, y: p.y });
      acc.events.push({ type: "FloodFill", x: p.x, y: p.y });
      painting = true;
    });
    canvas.addEventListener("mousemove", (e) => {
      if (!painting) return;
      const p = eventToBitmap(e);
      if (!p) return;
      acc.events.push({ type: "PaintStrokeMove", x: p.x, y: p.y });
    });
    const endStroke = () => {
      if (!painting) return;
      painting = false;
      acc.events.push({ type: "PaintStrokeEnd" });
    };
    canvas.addEventListener("mouseup", endStroke);
    canvas.addEventListener("mouseleave", endStroke);
  }

  if (dom.paintBtn) dom.paintBtn.addEventListener("click", () => acc.events.push({ type: "BrushToolSet", tool: "paint" }));
  if (dom.fillBtn) dom.fillBtn.addEventListener("click", () => acc.events.push({ type: "BrushToolSet", tool: "fill" }));
  if (dom.undoBtn) dom.undoBtn.addEventListener("click", () => acc.events.push({ type: "Undo" }));
  if (dom.redoBtn) dom.redoBtn.addEventListener("click", () => acc.events.push({ type: "Redo" }));
  if (dom.sendBtn) dom.sendBtn.addEventListener("click", () => acc.events.push({ type: "SendToWorld" }));
  if (dom.brushSizeSel) {
    // Slider: emit on every input event so dragging updates live.
    dom.brushSizeSel.addEventListener("input", () => {
      const v = parseInt(dom.brushSizeSel!.value, 10);
      if (Number.isFinite(v)) acc.events.push({ type: "BrushSizeSet", size: v });
    });
  }
}

/**
 * The pump system has no buffer access; DOM handlers append directly to the
 * accumulator and BuilderSystem drains them. The system exists in the graph
 * for documentation purposes ("DOM events flow into the builder here").
 */
export function createBuilderInputSystem(_acc: BuilderInputAccumulator): SystemDescriptor {
  return {
    id: BUILDER_INPUT_SYSTEM_ID,
    description: "Placeholder for the DOM-event pump that feeds BuilderSystem. No buffer access.",
    buffers: [],
    runsAfter: [STATE_MACHINE_SYSTEM_ID],
    execute: () => { /* no-op; DOM handlers append directly to accumulator */ },
  };
}

export type { PaletteEntry };
export { BUILDER_BUFFER_ID };
