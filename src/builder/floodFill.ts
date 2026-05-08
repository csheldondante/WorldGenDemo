/**
 * 4-connected flood fill on an RGBA bitmap. Pure: takes pixels in, returns a
 * new Uint8ClampedArray. Iterative (no recursion stack on 256² maps).
 *
 * Replaces the connected region of the same color as the seed pixel with
 * `replaceRgba`. If the seed already matches `replaceRgba`, returns a copy
 * with no changes.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const s = hex.replace(/^#/, "");
  const v = parseInt(s, 16);
  return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff, a: alpha };
}

export function readPixel(pixels: Uint8ClampedArray, w: number, x: number, y: number): RGBA {
  const i = (y * w + x) * 4;
  return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: pixels[i + 3] };
}

function eq(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function writePixel(pixels: Uint8ClampedArray, w: number, x: number, y: number, c: RGBA): void {
  const i = (y * w + x) * 4;
  pixels[i] = c.r;
  pixels[i + 1] = c.g;
  pixels[i + 2] = c.b;
  pixels[i + 3] = c.a;
}

/**
 * Flood fill 4-connected. Returns a new bitmap; does not mutate input.
 *
 * If `seedX/seedY` is out of bounds, returns a copy with no changes.
 * If the seed pixel already matches `replace`, also a no-op copy.
 */
export function floodFill4(
  pixels: Uint8ClampedArray,
  w: number,
  h: number,
  seedX: number,
  seedY: number,
  replace: RGBA,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels);
  if (seedX < 0 || seedY < 0 || seedX >= w || seedY >= h) return out;
  const target = readPixel(out, w, seedX, seedY);
  if (eq(target, replace)) return out;

  // BFS via a stack of integer indices to avoid object churn at 65k pixels.
  const stack: number[] = [seedY * w + seedX];
  while (stack.length) {
    const idx = stack.pop()!;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (!eq(readPixel(out, w, x, y), target)) continue;
    writePixel(out, w, x, y, replace);
    if (x > 0) stack.push(idx - 1);
    if (x < w - 1) stack.push(idx + 1);
    if (y > 0) stack.push(idx - w);
    if (y < h - 1) stack.push(idx + w);
  }
  return out;
}
