/**
 * Integration scenario for the Rebuilding pipeline. Covers:
 *
 *   - parseBitmapSystem (image + scene.json → labelMap)
 *   - splitLayersSystem (labelMap → terrainMap + assetMap)
 *   - jfaSystem (terrainMap → distance fields)
 *   - heightmapSystem (terrainMap → heightmap)
 *   - terrainMeshSystem (heightmap → BufferGeometry, lives in RenderRefsBuffer — excluded from snapshot)
 *   - assetPlacementSystem (assetMap → asset meshes, also excluded)
 *   - surfaceProviderSystem (heightmap → HeightmapSurfaceProvider — class, excluded)
 *   - parametricSurfaceSystem (no-op for bitmap scenes)
 *   - playerSpawnSystem (spawns the player entity)
 *
 * Seed: synthetic 4×4 single-color bitmap + minimal scene.json. The
 * scene declares one terrain label matching the pixel color so
 * parseBitmap succeeds. No assets (= keeps the test scoped).
 *
 * Output snapshot: EntityBuffer + TransformBuffer + StateMachine
 * (= playerSpawn's observable output). WorldDataBuffer + RenderRefs +
 * SurfaceProvider hold class instances / Three.js handles the
 * serializer refuses; they're excluded. The pipeline systems
 * running without throwing IS the coverage signal.
 */
import type { BufferTest } from "../src/app/bufferTest";
import { writeBuffer } from "../src/runtime/buffer";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
  type RebuildPayload,
} from "../src/runtime/stateMachine";

// Use tickActiveGraph below to drive the full registered Rebuilding
// graph (= same systems set graphs.ts assembles, with all the
// runsAfter / runsBefore ordering already in place). Hand-picking
// a subset would force us to re-encode the inter-system ordering.

function synthBitmap(): RebuildPayload {
  // 4×4 RGBA, all "desert" color (#d4a373 = 212, 163, 115).
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < 16; i++) {
    pixels[i * 4 + 0] = 0xd4;
    pixels[i * 4 + 1] = 0xa3;
    pixels[i * 4 + 2] = 0x73;
    pixels[i * 4 + 3] = 0xff;
  }
  return {
    sceneName: "test-pipeline",
    pixels,
    width: 4,
    height: 4,
    scene: {
      name: "test-pipeline",
      tileSize: 1,
      labels: [
        { color: "#d4a373", kind: "terrain", terrain: "desert" },
      ],
    },
    image: {} as HTMLImageElement,
  };
}

export const test: BufferTest = {
  name: "rebuild-pipeline",
  description:
    "Synthetic 4×4 all-desert bitmap fed through the Rebuilding " +
    "pipeline (parse → split → jfa → heightmap → surface → spawn). " +
    "Verifies all pipeline systems run end-to-end without throwing " +
    "+ produces a deterministic player spawn.",
  input: {
    kind: "seed",
    fn: (reg) => {
      // Seed SM directly into Rebuilding with the synthetic payload.
      // Bumping rebuildGeneration ensures runOncePerRebuild fires
      // for each pipeline stage.
      writeBuffer(reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID), (d) => {
        d.state = "Rebuilding";
        d.activeGraph = "Rebuilding";
        d.activeMode = "Rebuilding";
        d.pendingRebuild = synthBitmap();
        d.rebuildGeneration = 1;
      });
    },
  },
  steps: [
    // Drive the registered Rebuilding graph via the SM's activeGraph
    // (= same systems graphs.ts assembles, with all the inter-system
    // ordering already validated). Two ticks: one for the pipeline
    // to run (runOncePerRebuild fires when rebuildGeneration is new),
    // a second so any state transitions stabilize.
    { kind: "tickActiveGraph", ticks: 2, dt: 1 / 60 },
  ],
  output: {
    // Render-coupled buffers (renderRefs, worldData, surfaceProvider)
    // hold non-serializable values + are deliberately omitted. The
    // pipeline running cleanly produces a player entity + transform,
    // which is the observable correctness signal.
    snapshot: ["entity", "transform", "stateMachine", "timing"],
  },
};
