import type { PaletteEntry } from "../buffers/builder";
import type { SceneFile, TerrainId } from "../core/types";

/**
 * Build a SceneFile from a palette. Pure. Assumes the palette has been validated
 * (no duplicate colors). Caller is responsible for naming the scene.
 *
 * Drops any entry with an empty color (shouldn't happen if validation is done
 * upfront, but defensive).
 */
export function sceneFromPalette(
  palette: readonly PaletteEntry[],
  name: string,
  tileSize: number,
): SceneFile {
  return {
    name,
    tileSize,
    labels: palette
      .filter((e) => e.color.length > 0)
      .map((e) => {
        if (e.kind === "terrain") {
          return { color: e.color, kind: "terrain" as const, terrain: e.id as TerrainId };
        }
        return { color: e.color, kind: "asset" as const, asset: e.id };
      }),
  };
}

export interface PaletteValidationError {
  kind: "duplicate-color";
  color: string;
  ids: string[];
}

/**
 * Returns a list of validation errors (empty array means valid). Currently
 * only checks for duplicate colors — that's the rule for the bitmap encoding
 * to stay unambiguous.
 */
export function validatePalette(palette: readonly PaletteEntry[]): PaletteValidationError[] {
  const byColor = new Map<string, string[]>();
  for (const e of palette) {
    const c = e.color.toLowerCase();
    const arr = byColor.get(c) ?? [];
    arr.push(e.id);
    byColor.set(c, arr);
  }
  const errors: PaletteValidationError[] = [];
  for (const [color, ids] of byColor) {
    if (ids.length > 1) errors.push({ kind: "duplicate-color", color, ids });
  }
  return errors;
}
