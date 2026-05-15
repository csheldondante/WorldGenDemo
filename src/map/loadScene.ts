import type { LabelMap, Palette, SceneFile } from "../core/types";
import { parseBitmap, buildPalette } from "./parseBitmap";

export interface LoadedScene {
  scene: SceneFile;
  palette: Palette;
  labelMap: LabelMap;
  /** The original bitmap, kept so the UI can show it in a minimap. */
  image: HTMLImageElement;
}

async function fetchPng(url: string): Promise<{ image: HTMLImageElement; width: number; height: number; pixels: Uint8ClampedArray }> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  const loaded = new Promise<HTMLImageElement>((res, rej) => {
    img.onload = () => res(img);
    img.onerror = () => rej(new Error(`failed to load image ${url}`));
  });
  img.src = url;
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { image: img, width: canvas.width, height: canvas.height, pixels: data.data };
}

export async function loadScene(name: string): Promise<LoadedScene> {
  const sceneUrl = `/maps/${name}/scene.json`;
  const mapUrl = `/maps/${name}/map.png`;

  const sceneRes = await fetch(sceneUrl);
  if (!sceneRes.ok) throw new Error(`scene not found: ${sceneUrl}`);
  const scene = (await sceneRes.json()) as SceneFile;

  // Parametric (gym) scenes have no PNG — the SurfaceProvider is built analytically by
  // parametricSurfaceSystem from scene.parametric. Return a placeholder labelMap so the
  // existing LoadedScene shape stays uniform; downstream bitmap stages early-out when
  // scene.parametric is present.
  if (scene.parametric) {
    const palette = buildPalette(scene); // empty labels is fine
    const labelMap = parseBitmap({
      width: 1, height: 1,
      pixels: new Uint8ClampedArray([0, 0, 0, 0]),
      palette,
      tileSize: scene.tileSize,
    });
    const image = new Image(); // unused for parametric, but the LoadedScene shape expects one
    return { scene, palette, labelMap, image };
  }

  const palette = buildPalette(scene); // throws on unknown id

  const png = await fetchPng(mapUrl);
  const labelMap = parseBitmap({
    width: png.width,
    height: png.height,
    pixels: png.pixels,
    palette,
    tileSize: scene.tileSize,
  });
  return { scene, palette, labelMap, image: png.image };
}
