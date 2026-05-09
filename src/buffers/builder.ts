import { createBuffer, type Buffer } from "../runtime/buffer";

export interface PaletteEntry {
  /** "terrain" or "asset" — determines what the painted region becomes in the world. */
  kind: "terrain" | "asset";
  /** Catalog id (e.g. "desert", "cactus"). Must exist in TerrainCatalog or AssetCatalog. */
  id: string;
  /** Hex color used to encode this id in the bitmap. Must be unique within the palette. */
  color: string;
}

/** One snapshot of the bitmap for undo/redo. */
export interface HistoryFrame {
  /** Full RGBA bitmap copy. ~256 KB at 256² — fine to snapshot per stroke. */
  pixels: Uint8ClampedArray;
}

export interface BuilderBufferData {
  /** Bitmap canvas, RGBA8, row-major. */
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  /** Painted-id mapping. Order matters for UI display. */
  palette: PaletteEntry[];
  /** Currently selected catalog id for paint. null on first activation, before user picks. */
  activeId: string | null;
  /** Brush extent in pixels (1-25, odd values render symmetric). */
  brushSize: number;
  /** Current tool. paint = drag-to-paint; fill = single-click flood-fill 4-connected. */
  brushTool: "paint" | "fill";
  /**
   * Catalog id → data URL (PNG). Generated once at first Builder activation by
   * `thumbnailRenderer.ts`; stable across the session.
   */
  thumbnails: Map<string, string>;
  /** Per-stroke bitmap snapshots; capped at HISTORY_LIMIT. */
  history: HistoryFrame[];
  /** Index into `history`. Points at the current state. Undo decrements; redo increments. */
  historyIndex: number;
  /** Whether the current bitmap differs from the last "Send to World" snapshot. */
  dirty: boolean;
  /** Bumped each time SendToWorld emits. UI uses this to clear a "sending..." indicator. */
  paintGeneration: number;
  /**
   * Tracks whether the buffer has been bootstrapped (palette loaded, bitmap copied
   * from active scene). The system reads this on first Builder tick and seeds itself.
   */
  bootstrapped: boolean;
  /**
   * Transient inline error, cleared next mutation. e.g. "color clashes with existing palette entry".
   */
  errorMessage: string | null;
}

export const BUILDER_BUFFER_ID = "builder";
export const HISTORY_LIMIT = 32;

export function createBuilderBuffer(): Buffer<BuilderBufferData> {
  return createBuffer<BuilderBufferData>({
    id: BUILDER_BUFFER_ID,
    description:
      "Mode-bounded editor state: bitmap, palette of {kind,id,color} entries, active brush, undo history, thumbnails. Lifetime is the editor session, not per-scene.",
    initial: {
      pixels: new Uint8ClampedArray(0),
      width: 0,
      height: 0,
      palette: [],
      activeId: null,
      brushSize: 3,
      brushTool: "paint",
      thumbnails: new Map(),
      history: [],
      historyIndex: -1,
      dirty: false,
      paintGeneration: 0,
      bootstrapped: false,
      errorMessage: null,
    },
  });
}
