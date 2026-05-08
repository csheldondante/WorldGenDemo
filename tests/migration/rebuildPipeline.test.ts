import { describe, it, expect, beforeEach } from "vitest";
import * as THREE from "three";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../../src/buffers/renderRefs";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../src/buffers/stateMachine";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../../src/buffers/worldData";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "../../src/buffers/event";
import { createStateMachineSystem } from "../../src/runtime/stateMachine";
import { createParseBitmapSystem } from "../../src/systems/pipeline/parseBitmap";
import { createSplitLayersSystem } from "../../src/systems/pipeline/splitLayers";
import { createHeightmapSystem } from "../../src/systems/pipeline/heightmap";
import { AssetCatalog } from "../../src/assets/catalog";
import type { SceneFile } from "../../src/core/types";

beforeEach(() => {
  AssetCatalog.reset();
});

function makeTinyScene(): { sceneName: string; pixels: Uint8ClampedArray; width: number; height: number; scene: SceneFile; image: HTMLImageElement } {
  // 4x4 image: 3 pixels of desert, 1 pixel of water
  const w = 4, h = 4;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = 0xd4;
    pixels[i * 4 + 1] = 0xa3;
    pixels[i * 4 + 2] = 0x73;
    pixels[i * 4 + 3] = 255;
  }
  // Last pixel = water
  pixels[(w * h - 1) * 4] = 0x3b;
  pixels[(w * h - 1) * 4 + 1] = 0x6e;
  pixels[(w * h - 1) * 4 + 2] = 0x8f;
  const scene: SceneFile = {
    name: "tiny",
    tileSize: 1,
    labels: [
      { color: "#d4a373", kind: "terrain", terrain: "desert" },
      { color: "#3b6e8f", kind: "terrain", terrain: "water" },
    ],
  };
  // Stub HTMLImageElement; pipeline doesn't use it for parseBitmap, only stored in WorldDataBuffer.
  const image = {} as HTMLImageElement;
  return { sceneName: "tiny", pixels, width: w, height: h, scene, image };
}

describe("Rebuild pipeline (parse + split + heightmap)", () => {
  it("seeds RebuildRequested and produces a heightmap after one Rebuilding tick", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());
    reg.registerSystem(createParseBitmapSystem());
    reg.registerSystem(createSplitLayersSystem());
    reg.registerSystem(createHeightmapSystem());

    // Seed RebuildRequested + put SM into Rebuilding so pipeline systems run this tick
    const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
    const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    const tiny = makeTinyScene();
    // Skip the Running graph — set Rebuilding state directly with pendingRebuild
    writeBuffer(sm, (d) => {
      d.state = "Rebuilding";
      d.activeGraph = "Rebuilding";
      d.pendingRebuild = tiny;
      d.rebuildGeneration = 1;
    });
    void events;

    // Ensure RenderRefsBuffer is wired with a scene (needed by terrainMesh in real run; we skip those here)
    const refs = reg.getBuffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID);
    writeBuffer(refs, (d) => { d.scene = new THREE.Scene(); });

    // Build a partial graph: SM + parse + split + heightmap (skip JFA/terrainMesh which need a renderer)
    const g = buildExecutionGraph({
      id: "rebuildSubset",
      nodes: ["stateMachineSystem", "parseBitmapSystem", "splitLayersSystem", "heightmapSystem"],
      registry: reg,
    });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const world = readBuffer(reg.getBuffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
    expect(world.labelMap).not.toBeNull();
    expect(world.labelMap!.width).toBe(4);
    expect(world.terrainMap).not.toBeNull();
    expect(world.heightmap).not.toBeNull();
    expect(world.heightmap!.data.length).toBe(16);
    expect(world.sceneName).toBe("tiny");
  });

  it("skips work when not in Rebuilding state", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());
    reg.registerSystem(createParseBitmapSystem());

    // SM stays Running (default); pipeline should not run
    const tiny = makeTinyScene();
    const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    writeBuffer(sm, (d) => {
      d.pendingRebuild = tiny; // payload present
      d.rebuildGeneration = 1; // generation set
      d.state = "Running"; // but state is Running
      d.activeGraph = "Running";
    });

    const g = buildExecutionGraph({
      id: "g",
      nodes: ["stateMachineSystem", "parseBitmapSystem"],
      registry: reg,
    });
    executeGraph(g, reg, { dt: 0, now: 0 });

    const world = readBuffer(reg.getBuffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
    expect(world.labelMap).toBeNull(); // pipeline did not run
    expect(world.sceneName).toBeNull();
  });

  it("processes the same generation only once across multiple ticks", () => {
    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createStateMachineSystem());
    reg.registerSystem(createParseBitmapSystem());

    const tiny = makeTinyScene();
    const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
    writeBuffer(sm, (d) => {
      d.state = "Rebuilding";
      d.activeGraph = "Rebuilding";
      d.pendingRebuild = tiny;
      d.rebuildGeneration = 1;
    });

    const g = buildExecutionGraph({
      id: "g",
      nodes: ["stateMachineSystem", "parseBitmapSystem"],
      registry: reg,
    });
    executeGraph(g, reg, { dt: 0, now: 0 });
    const world1 = readBuffer(reg.getBuffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
    const v1 = reg.getBuffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID).version;
    expect(world1.labelMap).not.toBeNull();

    executeGraph(g, reg, { dt: 0, now: 0 });
    const v2 = reg.getBuffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID).version;
    // No additional write to WorldDataBuffer on the second tick (same generation)
    expect(v2).toBe(v1);
  });
});
