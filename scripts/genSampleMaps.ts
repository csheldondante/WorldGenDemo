// Run with: npx tsx scripts/genSampleMaps.ts
// Generates public/maps/{canyon-desert,forest-clearing}/{map.png, scene.json}
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { DEFAULT_COLORS } from "../src/builder/defaults";

type RGB = [number, number, number];

function hexToRGB(hex: string): RGB {
  const v = parseInt(hex.replace(/^#/, ""), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

const COLORS: Record<string, RGB> = Object.fromEntries(
  Object.entries(DEFAULT_COLORS).map(([k, v]) => [k, hexToRGB(v)]),
);

function crc32(buf: Buffer): number {
  let table = (crc32 as any).table as number[] | undefined;
  if (!table) {
    table = new Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    (crc32 as any).table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type RGB
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  // Build raw scanlines: filter byte 0 + RGB row
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idatData), chunk("IEND", Buffer.alloc(0))]);
}

interface PaintCtx {
  width: number;
  height: number;
  put(x: number, y: number, c: RGB): void;
  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB): void;
  fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void;
  splatNoise(c: RGB, density: number, seed: number, mask?: (x: number, y: number) => boolean): void;
  withinTerrain(x: number, y: number, t: RGB): boolean;
}

function makeCanvas(width: number, height: number, fill: RGB): { buf: Buffer; ctx: PaintCtx } {
  const buf = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    buf[i * 3] = fill[0];
    buf[i * 3 + 1] = fill[1];
    buf[i * 3 + 2] = fill[2];
  }
  function put(x: number, y: number, c: RGB) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2];
  }
  function fillRect(x0: number, y0: number, x1: number, y1: number, c: RGB) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(x, y, c);
  }
  function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB) {
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(width - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(height - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) put(x, y, c);
      }
    }
  }
  function splatNoise(c: RGB, density: number, seed: number, mask?: (x: number, y: number) => boolean) {
    let s = seed >>> 0;
    function rng() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }
    const target = Math.floor(width * height * density);
    let placed = 0, attempts = 0;
    while (placed < target && attempts < target * 50) {
      attempts++;
      const x = Math.floor(rng() * width);
      const y = Math.floor(rng() * height);
      if (mask && !mask(x, y)) continue;
      put(x, y, c);
      placed++;
    }
  }
  function withinTerrain(x: number, y: number, t: RGB) {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = (y * width + x) * 3;
    return buf[i] === t[0] && buf[i + 1] === t[1] && buf[i + 2] === t[2];
  }
  return { buf, ctx: { width, height, put, fillRect, fillEllipse, splatNoise, withinTerrain } };
}

function painterPath(p: PaintCtx, points: [number, number][], color: RGB, half: number) {
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      for (let dy = -half; dy <= half; dy++)
        for (let dx = -half; dx <= half; dx++)
          if (dx * dx + dy * dy <= half * half) p.put(x + dx, y + dy, color);
    }
  }
}

function genCanyonDesert(): { buf: Buffer; w: number; h: number; scene: object } {
  const W = 256, H = 256;
  const { buf, ctx } = makeCanvas(W, H, COLORS.desert);

  // Two canyon walls — large, irregular blobs
  ctx.fillEllipse(56, 80, 28, 38, COLORS.canyon_wall);
  ctx.fillEllipse(40, 130, 22, 30, COLORS.canyon_wall);
  ctx.fillEllipse(68, 175, 18, 24, COLORS.canyon_wall);
  ctx.fillEllipse(210, 60, 28, 22, COLORS.canyon_wall);
  ctx.fillEllipse(218, 110, 22, 30, COLORS.canyon_wall);
  ctx.fillEllipse(200, 170, 32, 26, COLORS.canyon_wall);

  // Water river meandering through middle
  painterPath(ctx, [[0, 200], [40, 195], [90, 190], [130, 200], [170, 195], [210, 190], [256, 195]], COLORS.water, 4);

  // Path leading from south to north
  painterPath(ctx, [[128, 256], [128, 220], [120, 200], [125, 170], [115, 140], [120, 110], [115, 80], [128, 40], [128, 0]], COLORS.path, 3);

  // Bridge over the water where the path crosses
  ctx.fillRect(118, 192, 138, 200, COLORS.bridge);

  // Cacti scattered on desert tiles only
  ctx.splatNoise(COLORS.cactus, 0.0035, 0xc4c7,
    (x, y) => ctx.withinTerrain(x, y, COLORS.desert));

  // Shanties hugging canyon walls — small ellipses on the desert side adjacent to wall
  const shantySpots: [number, number][] = [
    [88, 95], [88, 165], [188, 75], [188, 130], [180, 165],
  ];
  for (const [x, y] of shantySpots) ctx.fillEllipse(x, y, 5, 4, COLORS.shanty);

  return {
    buf, w: W, h: H,
    scene: {
      name: "canyon-desert",
      tileSize: 0.6,
      labels: [
        { color: rgb2hex(COLORS.desert),      kind: "terrain", terrain: "desert" },
        { color: rgb2hex(COLORS.canyon_wall), kind: "terrain", terrain: "canyon_wall" },
        { color: rgb2hex(COLORS.path),        kind: "terrain", terrain: "path" },
        { color: rgb2hex(COLORS.water),       kind: "terrain", terrain: "water" },
        { color: rgb2hex(COLORS.cactus),      kind: "asset",   asset: "cactus" },
        { color: rgb2hex(COLORS.shanty),      kind: "asset",   asset: "shanty" },
        { color: rgb2hex(COLORS.bridge),      kind: "asset",   asset: "bridge" },
      ],
    },
  };
}

function genForestClearing(): { buf: Buffer; w: number; h: number; scene: object } {
  const W = 256, H = 256;
  const { buf, ctx } = makeCanvas(W, H, COLORS.forest);

  // Big plains clearing in the middle
  ctx.fillEllipse(128, 128, 70, 60, COLORS.plains);
  ctx.fillEllipse(180, 110, 30, 26, COLORS.plains);

  // A pond
  ctx.fillEllipse(95, 145, 22, 14, COLORS.water);

  // A dirt path through
  painterPath(ctx, [[0, 130], [60, 135], [110, 140], [160, 130], [220, 135], [256, 130]], COLORS.path, 2);

  // Pines scattered across forest tiles
  ctx.splatNoise(COLORS.pine, 0.012, 0xa17e,
    (x, y) => ctx.withinTerrain(x, y, COLORS.forest));

  // Boulders on plains and forest
  ctx.splatNoise(COLORS.boulder, 0.0015, 0xbeef,
    (x, y) => ctx.withinTerrain(x, y, COLORS.plains) || ctx.withinTerrain(x, y, COLORS.forest));

  return {
    buf, w: W, h: H,
    scene: {
      name: "forest-clearing",
      tileSize: 0.6,
      labels: [
        { color: rgb2hex(COLORS.forest),  kind: "terrain", terrain: "forest" },
        { color: rgb2hex(COLORS.plains),  kind: "terrain", terrain: "plains" },
        { color: rgb2hex(COLORS.path),    kind: "terrain", terrain: "path" },
        { color: rgb2hex(COLORS.water),   kind: "terrain", terrain: "water" },
        { color: rgb2hex(COLORS.pine),    kind: "asset",   asset: "pine" },
        { color: rgb2hex(COLORS.boulder), kind: "asset",   asset: "boulder" },
      ],
    },
  };
}

function rgb2hex(c: RGB): string {
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

function emit(name: string, gen: () => { buf: Buffer; w: number; h: number; scene: object }) {
  const dir = resolve(`public/maps/${name}`);
  mkdirSync(dir, { recursive: true });
  const { buf, w, h, scene } = gen();
  const png = encodePng(w, h, buf);
  writeFileSync(resolve(dir, "map.png"), png);
  writeFileSync(resolve(dir, "scene.json"), JSON.stringify(scene, null, 2));
  console.log(`wrote public/maps/${name}/map.png (${w}x${h}) + scene.json`);
}

emit("canyon-desert", genCanyonDesert);
emit("forest-clearing", genForestClearing);
