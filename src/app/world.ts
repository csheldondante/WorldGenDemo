import { createSceneBundle } from "../render/scene";
import { createFlyCam } from "../render/camera";
import { loadScene } from "../map/loadScene";
import { splitLayers } from "../map/splitLayers";
import { buildHeightmap } from "../map/heightmap";
import { runJFA } from "../map/jfa";
import { buildTerrainMesh } from "../map/terrainMesh";
import { placeAssets } from "../map/placeAssets";
import { buildProceduralTextures } from "../terrain/textures";
import { registerBuiltinAssets } from "../assets/register";

export interface WorldOptions {
  hudEl: HTMLElement;
  hintEl: HTMLElement;
  panelEl: HTMLElement;
}

interface Timings {
  load: number;
  parse: number;
  split: number;
  jfa: number;
  height: number;
  terrain: number;
  components: number;
  total: number;
  warnings: number;
  scene: string;
}

export async function startWorld(opts: WorldOptions) {
  registerBuiltinAssets();

  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  opts.panelEl.insertBefore(canvas, opts.panelEl.firstChild);

  const { scene, renderer } = createSceneBundle(canvas);
  const cam = createFlyCam();
  cam.setAttached(canvas, opts.hintEl);

  window.addEventListener("resize", () => {
    cam.camera.aspect = innerWidth / innerHeight;
    cam.camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
  });

  const url = new URL(location.href);
  const sceneName = url.searchParams.get("map") ?? "canyon-desert";

  function setHud(t: Partial<Timings>) {
    const lines = [
      `scene: ${t.scene ?? sceneName}`,
      `load:        ${(t.load ?? 0).toFixed(1).padStart(6)} ms`,
      `parse:       ${(t.parse ?? 0).toFixed(1).padStart(6)} ms`,
      `split:       ${(t.split ?? 0).toFixed(1).padStart(6)} ms`,
      `jfa:         ${(t.jfa ?? 0).toFixed(1).padStart(6)} ms`,
      `heightmap:   ${(t.height ?? 0).toFixed(1).padStart(6)} ms`,
      `terrainMesh: ${(t.terrain ?? 0).toFixed(1).padStart(6)} ms`,
      `assets:      ${(t.components ?? 0).toFixed(1).padStart(6)} ms`,
      `total:       ${(t.total ?? 0).toFixed(1).padStart(6)} ms`,
      `warnings:    ${t.warnings ?? 0}`,
    ];
    opts.hudEl.textContent = lines.join("\n");
  }

  setHud({ scene: sceneName });

  const tStart = performance.now();
  let tLoad = 0, tParse = 0, tSplit = 0, tJfa = 0, tHeight = 0, tTerrain = 0, tComponents = 0;
  let warnCount = 0;

  try {
    const t0 = performance.now();
    const loaded = await loadScene(sceneName);
    tLoad = performance.now() - t0;
    tParse = 0; // parseBitmap runs inside loadScene already; we don't separate here

    const t1 = performance.now();
    const { terrainMap, assetMap } = splitLayers(loaded.labelMap);
    tSplit = performance.now() - t1;

    const t2 = performance.now();
    const jfa = runJFA(renderer, terrainMap);
    tJfa = performance.now() - t2;

    const t3 = performance.now();
    const heightmap = buildHeightmap(terrainMap, { blurPasses: 2, jitter: 0.04, seed: 1 });
    tHeight = performance.now() - t3;

    const t4 = performance.now();
    const textures = buildProceduralTextures();
    const terrainMesh = buildTerrainMesh(heightmap, {
      distance: jfa.distance,
      gradient: jfa.gradient,
      channelTerrains: jfa.channelTerrains,
      textures,
    });
    scene.add(terrainMesh);
    tTerrain = performance.now() - t4;

    const t5 = performance.now();
    const placement = placeAssets({ assetMap, terrainMap, heightmap, seed: 0xa5b1 });
    for (const m of placement.meshes) scene.add(m);
    tComponents = performance.now() - t5;
    warnCount = placement.warnings.length;
    if (placement.warnings.length) {
      // eslint-disable-next-line no-console
      console.warn("placement warnings:", placement.warnings);
    }
  } catch (err) {
    console.error(err);
    opts.hudEl.textContent = `error: ${(err as Error).message}\n(see console)`;
  }

  const tTotal = performance.now() - tStart;
  setHud({
    scene: sceneName,
    load: tLoad,
    parse: tParse,
    split: tSplit,
    jfa: tJfa,
    height: tHeight,
    terrain: tTerrain,
    components: tComponents,
    total: tTotal,
    warnings: warnCount,
  });

  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    cam.update(dt);
    renderer.render(scene, cam.camera);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
