import { describe, it, expect } from "vitest";
import { floodFill4, hexToRgba, readPixel } from "../../src/builder/floodFill";
import { expectBaselined } from "../../src/lib/testing/baseline";

function makeBitmap(w: number, h: number, fillRgb: [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = fillRgb[0];
    out[i * 4 + 1] = fillRgb[1];
    out[i * 4 + 2] = fillRgb[2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

describe("floodFill4", () => {
  it("fills the entire bitmap when seeded on a uniform fill", () => {
    const px = makeBitmap(4, 4, [10, 10, 10]);
    const out = floodFill4(px, 4, 4, 0, 0, hexToRgba("#ff0000"));
    for (let i = 0; i < 16; i++) {
      expect(out[i * 4]).toBe(255);
      expect(out[i * 4 + 1]).toBe(0);
    }
  });

  it("respects color boundaries (4-connected)", () => {
    // 3x3, center is a different color, surrounded by uniform background
    const px = makeBitmap(3, 3, [0, 0, 0]);
    // make center red
    const i = (1 * 3 + 1) * 4;
    px[i] = 255; px[i + 1] = 0; px[i + 2] = 0;
    const out = floodFill4(px, 3, 3, 1, 1, hexToRgba("#00ff00"));
    // center → green; rest stays black
    expect(readPixel(out, 3, 1, 1)).toEqual({ r: 0, g: 255, b: 0, a: 255 });
    expect(readPixel(out, 3, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 255 });
  });

  it("does not change anything when seed already matches replace color", () => {
    const px = makeBitmap(2, 2, [0, 255, 0]);
    const out = floodFill4(px, 2, 2, 0, 0, hexToRgba("#00ff00"));
    expect(Array.from(out)).toEqual(Array.from(px));
  });

  it("returns a new bitmap (does not mutate input)", () => {
    const px = makeBitmap(2, 2, [0, 0, 0]);
    const out = floodFill4(px, 2, 2, 0, 0, hexToRgba("#ff0000"));
    expect(out).not.toBe(px);
    expect(px[0]).toBe(0); // input unchanged
    expect(out[0]).toBe(255);
  });

  it("out-of-bounds seed is a no-op (returns copy)", () => {
    const px = makeBitmap(2, 2, [0, 0, 0]);
    const out = floodFill4(px, 2, 2, -1, -1, hexToRgba("#ff0000"));
    expect(Array.from(out)).toEqual(Array.from(px));
  });

  it("baselines a fixed pattern", () => {
    // 5x5: outer ring black, inner 3x3 white, center pixel orange
    const w = 5, h = 5;
    const px = makeBitmap(w, h, [0, 0, 0]);
    for (let y = 1; y < 4; y++) {
      for (let x = 1; x < 4; x++) {
        const i = (y * w + x) * 4;
        px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
      }
    }
    const ic = (2 * w + 2) * 4;
    px[ic] = 255; px[ic + 1] = 128; px[ic + 2] = 0;

    // Flood-fill the white ring with green; orange center stays.
    const out = floodFill4(px, w, h, 1, 1, hexToRgba("#00ff00"));
    expectBaselined("floodFill.5x5.ring", out);
  });
});
