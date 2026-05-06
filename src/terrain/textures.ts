import * as THREE from "three";
import { mulberry32 } from "../core/rng";

// Procedural tiling textures generated on a 256x256 canvas.
// They are intentionally low-budget — the splat shader does the heavy lifting.

type TextureKey = "sand" | "snow" | "grass" | "rock" | "water" | "dirt";

export const TEXTURE_KEYS: TextureKey[] = ["sand", "snow", "grass", "rock", "water", "dirt"];

const SIZE = 256;

function noise(rng: () => number, scale: number, x: number, y: number): number {
  // 4-tap value-noise; cheap and seamless when paired with mod
  let total = 0, amp = 1, sum = 0;
  for (let o = 0; o < 4; o++) {
    const sx = (x * scale * Math.pow(2, o)) | 0;
    const sy = (y * scale * Math.pow(2, o)) | 0;
    const seed = ((sx & 1023) * 31 + (sy & 1023) * 7 + o * 17) ^ 0x9e3779b1;
    const r = mulberry32((seed >>> 0) ^ (rng() * 0xffffffff)) ();
    total += r * amp;
    sum += amp;
    amp *= 0.5;
  }
  return total / sum;
}

function makeCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; data: ImageData } {
  const canvas = document.createElement("canvas");
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const data = ctx.createImageData(SIZE, SIZE);
  return { canvas, ctx, data };
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

type Painter = (rng: () => number, x: number, y: number) => [number, number, number];

const PAINTERS: Record<TextureKey, Painter> = {
  sand: (rng, x, y) => {
    const n = noise(rng, 0.06, x, y);
    return lerpRgb([214, 187, 130], [240, 220, 175], n);
  },
  snow: (rng, x, y) => {
    const n = noise(rng, 0.05, x, y);
    return lerpRgb([220, 230, 240], [255, 255, 255], n);
  },
  grass: (rng, x, y) => {
    const n = noise(rng, 0.18, x, y);
    return lerpRgb([60, 95, 45], [110, 150, 70], n);
  },
  rock: (rng, x, y) => {
    const n = noise(rng, 0.12, x, y);
    const m = noise(rng, 0.4, x + 17, y + 23);
    const base: [number, number, number] = lerpRgb([90, 70, 60], [150, 120, 100], n);
    return [base[0] * (0.85 + m * 0.3), base[1] * (0.85 + m * 0.3), base[2] * (0.85 + m * 0.3)];
  },
  water: (rng, x, y) => {
    const n = noise(rng, 0.2, x, y);
    return lerpRgb([40, 80, 130], [80, 130, 180], n);
  },
  dirt: (rng, x, y) => {
    const n = noise(rng, 0.14, x, y);
    return lerpRgb([110, 85, 60], [150, 120, 90], n);
  },
};

export function buildProceduralTextures(): Record<TextureKey, THREE.Texture> {
  const out = {} as Record<TextureKey, THREE.Texture>;
  for (const key of TEXTURE_KEYS) {
    const painter = PAINTERS[key];
    const rng = mulberry32(0xc0ffee ^ key.charCodeAt(0) ^ (key.length << 16));
    const { canvas, ctx, data } = makeCanvas();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const [r, g, b] = painter(rng, x, y);
        const i = (y * SIZE + x) * 4;
        data.data[i] = r;
        data.data[i + 1] = g;
        data.data[i + 2] = b;
        data.data[i + 3] = 255;
      }
    }
    ctx.putImageData(data, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    out[key] = tex;
  }
  return out;
}
