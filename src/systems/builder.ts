import type { SystemDescriptor } from "../runtime/system";
import { readBuffer, writeBuffer } from "../runtime/buffer";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { BUILDER_BUFFER_ID, HISTORY_LIMIT, type BuilderBufferData, type PaletteEntry } from "../buffers/builder";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../buffers/stateMachine";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "../buffers/event";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../buffers/worldData";
import { TIMING_BUFFER_ID } from "../buffers/timing";
import { ALL_TERRAINS } from "../core/types";
import { AssetCatalog } from "../assets/catalog";
import { buildDefaultPalette, DEFAULT_COLORS, pickFreeColor } from "../builder/defaults";
import { floodFill4, hexToRgba, type RGBA } from "../builder/floodFill";
import { sceneFromPalette, validatePalette } from "../builder/sceneFromPalette";
import { generateThumbnails } from "../render/thumbnailRenderer";
import {
  BUILDER_INPUT_SYSTEM_ID,
  type BuilderInputAccumulator,
  type BuilderEvent,
  type BuilderDom,
} from "./builderInput";

export const BUILDER_SYSTEM_ID = "builderSystem";

const DEFAULT_CANVAS_SIZE = 64;
const FALLBACK_BG_COLOR: RGBA = { r: 14, g: 18, b: 24, a: 255 };

export function createBuilderSystem(
  acc: BuilderInputAccumulator,
  dom: BuilderDom,
): SystemDescriptor {
  let lastBufferVersion = -1;
  return {
    id: BUILDER_SYSTEM_ID,
    description:
      "Mutates BuilderBuffer in response to BuilderEvent[] from the DOM. Bootstraps the buffer on first activation. Rebuilds palette/asset-menu DOM when state changes. Emits RebuildRequested on Send-to-World.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: BUILDER_BUFFER_ID, access: "readwrite" },
      { id: WORLD_DATA_BUFFER_ID, access: "read" },
      { id: EVENT_BUFFER_ID, access: "readwrite" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, BUILDER_INPUT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      if (sm.state !== "Builder") return;

      const builderBuf = buffer<BuilderBufferData>(BUILDER_BUFFER_ID);
      const worldBuf = buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID);
      const eventsBuf = buffer<RuntimeEvent[]>(EVENT_BUFFER_ID);

      const builder = readBuffer(builderBuf);
      if (!builder.bootstrapped) {
        bootstrap(builderBuf, readBuffer(worldBuf));
      }

      // Drain accumulator FIFO; clear it.
      const events = acc.events.slice();
      acc.events.length = 0;
      for (const ev of events) {
        applyEvent(builderBuf, eventsBuf, ev);
      }

      // Re-render DOM if buffer version changed (any mutation bumps version).
      if (builderBuf.version !== lastBufferVersion) {
        const after = readBuffer(builderBuf);
        renderCanvas(after, dom);
        renderPalette(after, dom, acc);
        renderAssetMenu(after, dom, acc);
        renderToolbar(after, dom);
        renderError(after, dom);
        lastBufferVersion = builderBuf.version;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function bootstrap(
  builderBuf: import("../runtime/buffer").Buffer<BuilderBufferData>,
  world: WorldDataBufferData,
): void {
  let thumbnails: Map<string, string>;
  try {
    thumbnails = generateThumbnails();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[builder] thumbnail generation failed:", err);
    thumbnails = new Map();
  }

  // Canvas size + initial pixels: copy from active scene if available, else blank.
  let width = DEFAULT_CANVAS_SIZE;
  let height = DEFAULT_CANVAS_SIZE;
  let pixels: Uint8ClampedArray;
  if (world.image && world.labelMap) {
    width = world.labelMap.width;
    height = world.labelMap.height;
    pixels = extractPixelsFromImage(world.image, width, height);
  } else {
    pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = FALLBACK_BG_COLOR.r;
      pixels[i * 4 + 1] = FALLBACK_BG_COLOR.g;
      pixels[i * 4 + 2] = FALLBACK_BG_COLOR.b;
      pixels[i * 4 + 3] = FALLBACK_BG_COLOR.a;
    }
  }

  // Palette: scene labels ∪ defaults. Scene labels override defaults (they
  // reflect the actual colors used in the current bitmap).
  const fromScene: PaletteEntry[] = [];
  if (world.labelMap?.palette) {
    const p = world.labelMap.palette;
    for (let i = 0; i < p.colors.length; i++) {
      const colorHex = "#" + p.colors[i].toString(16).padStart(6, "0");
      if (p.kinds[i] === "terrain" && p.terrains[i]) {
        fromScene.push({ kind: "terrain", id: p.terrains[i]!, color: colorHex });
      } else if (p.kinds[i] === "asset" && p.assets[i]) {
        fromScene.push({ kind: "asset", id: p.assets[i]!, color: colorHex });
      }
    }
  }
  const defaults = buildDefaultPalette(AssetCatalog.ids());
  const seenIds = new Set(fromScene.map((e) => e.id));
  const seenColors = new Set(fromScene.map((e) => e.color.toLowerCase()));
  const palette: PaletteEntry[] = [...fromScene];
  for (const e of defaults) {
    if (seenIds.has(e.id)) continue;
    let color = e.color;
    if (seenColors.has(color.toLowerCase())) {
      color = pickFreeColor(palette);
    }
    palette.push({ kind: e.kind, id: e.id, color });
    seenIds.add(e.id);
    seenColors.add(color.toLowerCase());
  }

  writeBuffer(builderBuf, (d) => {
    d.pixels = pixels;
    d.width = width;
    d.height = height;
    d.palette = palette;
    d.thumbnails = thumbnails;
    d.activeId = palette[0]?.id ?? null;
    d.history = [{ pixels: new Uint8ClampedArray(pixels) }];
    d.historyIndex = 0;
    d.dirty = false;
    d.bootstrapped = true;
    d.errorMessage = null;
  });
}

function extractPixelsFromImage(image: HTMLImageElement, w: number, h: number): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

function applyEvent(
  builderBuf: import("../runtime/buffer").Buffer<BuilderBufferData>,
  eventsBuf: import("../runtime/buffer").Buffer<RuntimeEvent[]>,
  ev: BuilderEvent,
): void {
  const builder = readBuffer(builderBuf);
  switch (ev.type) {
    case "PaintStrokeBegin": {
      if (builder.brushTool !== "paint") return;
      const active = builder.palette.find((e) => e.id === builder.activeId);
      if (!active) return;
      writeBuffer(builderBuf, (d) => {
        const truncated = d.history.slice(0, d.historyIndex + 1);
        truncated.push({ pixels: new Uint8ClampedArray(d.pixels) });
        const dropped = Math.max(0, truncated.length - HISTORY_LIMIT);
        d.history = truncated.slice(dropped);
        d.historyIndex = d.history.length - 1;
        paintAt(d, ev.x, ev.y, hexToRgba(active.color));
        d.dirty = true;
      });
      break;
    }
    case "PaintStrokeMove": {
      if (builder.brushTool !== "paint") return;
      const active = builder.palette.find((e) => e.id === builder.activeId);
      if (!active) return;
      writeBuffer(builderBuf, (d) => {
        paintAt(d, ev.x, ev.y, hexToRgba(active.color));
      });
      break;
    }
    case "PaintStrokeEnd":
      break;
    case "FloodFill": {
      if (builder.brushTool !== "fill") return;
      const active = builder.palette.find((e) => e.id === builder.activeId);
      if (!active) return;
      writeBuffer(builderBuf, (d) => {
        const truncated = d.history.slice(0, d.historyIndex + 1);
        truncated.push({ pixels: new Uint8ClampedArray(d.pixels) });
        const dropped = Math.max(0, truncated.length - HISTORY_LIMIT);
        d.history = truncated.slice(dropped);
        d.historyIndex = d.history.length - 1;
        d.pixels = floodFill4(d.pixels, d.width, d.height, ev.x, ev.y, hexToRgba(active.color));
        d.dirty = true;
      });
      break;
    }
    case "Undo":
      writeBuffer(builderBuf, (d) => {
        if (d.historyIndex <= 0) return;
        d.historyIndex -= 1;
        d.pixels = new Uint8ClampedArray(d.history[d.historyIndex].pixels);
        d.dirty = true;
      });
      break;
    case "Redo":
      writeBuffer(builderBuf, (d) => {
        if (d.historyIndex >= d.history.length - 1) return;
        d.historyIndex += 1;
        d.pixels = new Uint8ClampedArray(d.history[d.historyIndex].pixels);
        d.dirty = true;
      });
      break;
    case "PaletteSelect":
      writeBuffer(builderBuf, (d) => {
        if (d.palette.some((e) => e.id === ev.id)) {
          d.activeId = ev.id;
          d.errorMessage = null;
        }
      });
      break;
    case "PaletteAdd": {
      writeBuffer(builderBuf, (d) => {
        if (d.palette.some((e) => e.id === ev.id)) return;
        let color = DEFAULT_COLORS[ev.id];
        if (!color || d.palette.some((e) => e.color.toLowerCase() === color!.toLowerCase())) {
          color = pickFreeColor(d.palette);
        }
        d.palette = [...d.palette, { kind: ev.kind, id: ev.id, color }];
        d.activeId = ev.id;
        d.errorMessage = null;
      });
      break;
    }
    case "PaletteRemove":
      writeBuffer(builderBuf, (d) => {
        d.palette = d.palette.filter((e) => e.id !== ev.id);
        if (d.activeId === ev.id) d.activeId = d.palette[0]?.id ?? null;
      });
      break;
    case "PaletteRecolor": {
      writeBuffer(builderBuf, (d) => {
        const hex = ev.color.toLowerCase();
        if (d.palette.some((e) => e.id !== ev.id && e.color.toLowerCase() === hex)) {
          d.errorMessage = `color ${ev.color} clashes with another palette entry`;
          return;
        }
        d.palette = d.palette.map((e) => (e.id === ev.id ? { ...e, color: ev.color } : e));
        d.errorMessage = null;
      });
      break;
    }
    case "BrushSizeSet":
      writeBuffer(builderBuf, (d) => { d.brushSize = ev.size; });
      break;
    case "BrushToolSet":
      writeBuffer(builderBuf, (d) => { d.brushTool = ev.tool; });
      break;
    case "SendToWorld": {
      const errors = validatePalette(builder.palette);
      if (errors.length > 0) {
        writeBuffer(builderBuf, (d) => {
          d.errorMessage = `palette has duplicate colors: ${errors[0].color} (${errors[0].ids.join(", ")})`;
        });
        return;
      }
      const sceneName = `painted-${builder.paintGeneration + 1}`;
      const scene = sceneFromPalette(builder.palette, sceneName, 0.6);
      const image = bitmapToImage(builder.pixels, builder.width, builder.height);
      writeBuffer(eventsBuf, (d) => {
        d.push({
          type: "RebuildRequested",
          payload: {
            sceneName,
            pixels: builder.pixels,
            width: builder.width,
            height: builder.height,
            scene,
            image,
          },
        });
        d.push({ type: "ModeRequested", payload: { mode: "world" } });
      });
      writeBuffer(builderBuf, (d) => {
        d.dirty = false;
        d.paintGeneration += 1;
        d.errorMessage = null;
      });
      break;
    }
  }
}

function paintAt(d: BuilderBufferData, cx: number, cy: number, color: RGBA): void {
  const r = (d.brushSize - 1) / 2;
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(d.width - 1, Math.floor(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(d.height - 1, Math.floor(cy + r));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * d.width + x) * 4;
      d.pixels[i] = color.r;
      d.pixels[i + 1] = color.g;
      d.pixels[i + 2] = color.b;
      d.pixels[i + 3] = color.a;
    }
  }
}

function bitmapToImage(pixels: Uint8ClampedArray, w: number, h: number): HTMLImageElement {
  // Headless tests don't have document — return a stub so SendToWorld is testable
  // without booting a DOM environment.
  if (typeof document === "undefined") return {} as HTMLImageElement;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d")!;
  const data = new ImageData(new Uint8ClampedArray(pixels), w, h);
  ctx.putImageData(data, 0, 0);
  const img = new Image();
  img.src = c.toDataURL("image/png");
  return img;
}

// ---------------------------------------------------------------------------
// DOM rendering
// ---------------------------------------------------------------------------

function renderCanvas(b: BuilderBufferData, dom: BuilderDom): void {
  const canvas = dom.paintCanvas;
  if (!canvas) return;
  if (canvas.width !== b.width || canvas.height !== b.height) {
    canvas.width = b.width;
    canvas.height = b.height;
    canvas.style.width = "min(70vw, 70vh, 720px)";
    canvas.style.height = "min(70vw, 70vh, 720px)";
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const data = new ImageData(new Uint8ClampedArray(b.pixels), b.width, b.height);
  ctx.putImageData(data, 0, 0);
}

function renderPalette(b: BuilderBufferData, dom: BuilderDom, acc: BuilderInputAccumulator): void {
  const list = dom.paletteListEl;
  if (!list) return;
  list.innerHTML = "";
  for (const entry of b.palette) {
    const row = document.createElement("div");
    row.className = "palette-row" + (entry.id === b.activeId ? " active" : "");
    row.addEventListener("click", () => acc.events.push({ type: "PaletteSelect", id: entry.id }));

    const thumb = document.createElement("div");
    thumb.className = "palette-thumb";
    const tUrl = b.thumbnails.get(entry.id);
    if (tUrl) thumb.style.backgroundImage = `url(${tUrl})`;
    else thumb.style.background = entry.color;
    row.appendChild(thumb);

    const info = document.createElement("div");
    info.className = "palette-info";
    info.innerHTML = `<div class="id-line">${escapeHtml(entry.id)}</div><div class="meta-line">${entry.kind}</div>`;
    row.appendChild(info);

    const colorBtn = document.createElement("input");
    colorBtn.type = "color";
    colorBtn.className = "palette-color";
    colorBtn.value = entry.color;
    colorBtn.addEventListener("click", (e) => e.stopPropagation());
    colorBtn.addEventListener("change", () => {
      acc.events.push({ type: "PaletteRecolor", id: entry.id, color: colorBtn.value });
    });
    row.appendChild(colorBtn);

    const remove = document.createElement("button");
    remove.className = "palette-remove";
    remove.textContent = "×";
    remove.title = "remove from palette";
    remove.addEventListener("click", (e) => {
      e.stopPropagation();
      acc.events.push({ type: "PaletteRemove", id: entry.id });
    });
    row.appendChild(remove);

    list.appendChild(row);
  }
}

function renderAssetMenu(b: BuilderBufferData, dom: BuilderDom, acc: BuilderInputAccumulator): void {
  const menu = dom.assetMenuEl;
  if (!menu) return;
  const inPalette = new Set(b.palette.map((e) => e.id));

  const candidates: { kind: "terrain" | "asset"; id: string }[] = [];
  for (const t of ALL_TERRAINS) if (!inPalette.has(t)) candidates.push({ kind: "terrain", id: t });
  for (const a of AssetCatalog.ids()) if (!inPalette.has(a)) candidates.push({ kind: "asset", id: a });

  menu.innerHTML = "";
  for (const c of candidates) {
    const tile = document.createElement("button");
    tile.className = "asset-tile";
    tile.title = `Add ${c.id} (${c.kind}) to palette`;
    tile.addEventListener("click", () => acc.events.push({ type: "PaletteAdd", id: c.id, kind: c.kind }));

    const thumb = document.createElement("div");
    thumb.className = "asset-tile-thumb";
    const tUrl = b.thumbnails.get(c.id);
    if (tUrl) thumb.style.backgroundImage = `url(${tUrl})`;
    else thumb.style.background = "#444";
    tile.appendChild(thumb);

    const name = document.createElement("div");
    name.className = "asset-tile-name";
    name.textContent = c.id;
    tile.appendChild(name);

    menu.appendChild(tile);
  }
  if (candidates.length === 0) {
    const empty = document.createElement("div");
    empty.style.gridColumn = "1 / -1";
    empty.style.color = "#777";
    empty.style.fontSize = "10px";
    empty.style.padding = "8px";
    empty.textContent = "all catalog ids are in your palette already";
    menu.appendChild(empty);
  }
}

function renderToolbar(b: BuilderBufferData, dom: BuilderDom): void {
  if (dom.paintBtn) dom.paintBtn.classList.toggle("active", b.brushTool === "paint");
  if (dom.fillBtn) dom.fillBtn.classList.toggle("active", b.brushTool === "fill");
  if (dom.brushSizeSel && dom.brushSizeSel.value !== String(b.brushSize)) {
    dom.brushSizeSel.value = String(b.brushSize);
  }
  if (dom.undoBtn) dom.undoBtn.disabled = b.historyIndex <= 0;
  if (dom.redoBtn) dom.redoBtn.disabled = b.historyIndex >= b.history.length - 1;
}

function renderError(b: BuilderBufferData, dom: BuilderDom): void {
  if (!dom.errorEl) return;
  if (b.errorMessage) {
    dom.errorEl.textContent = b.errorMessage;
    dom.errorEl.classList.add("shown");
  } else {
    dom.errorEl.classList.remove("shown");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
