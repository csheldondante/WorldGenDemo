import { describe, it, expect, beforeEach } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../src/buffers/stateMachine";
import { BUILDER_BUFFER_ID, type BuilderBufferData, type PaletteEntry } from "../../src/buffers/builder";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "../../src/buffers/event";
import { createStateMachineSystem } from "../../src/runtime/stateMachine";
import {
  createBuilderAccumulator,
  createBuilderInputSystem,
  createBuilderDom,
} from "../../src/systems/builderInput";
import { createBuilderSystem } from "../../src/systems/builder";
import { AssetCatalog } from "../../src/assets/catalog";

beforeEach(() => {
  AssetCatalog.reset();
  AssetCatalog.register({
    id: "cactus",
    generate: () => null as any,
    placement: { multiplicity: "fill", on_terrain: ["desert"] },
  });
});

function setup() {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  const acc = createBuilderAccumulator();
  const dom = createBuilderDom(); // all DOM refs are null — system handles gracefully
  reg.registerSystem(createStateMachineSystem());
  reg.registerSystem(createBuilderInputSystem(acc));
  reg.registerSystem(createBuilderSystem(acc, dom));
  const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
  // Skip Loading; put SM in Builder state with a pre-bootstrapped buffer.
  writeBuffer(sm, (d) => { d.state = "Builder"; d.activeGraph = "Builder"; });

  const builder = reg.getBuffer<BuilderBufferData>(BUILDER_BUFFER_ID);
  const palette: PaletteEntry[] = [
    { kind: "terrain", id: "desert", color: "#d4a373" },
    { kind: "terrain", id: "water", color: "#3b6e8f" },
    { kind: "asset", id: "cactus", color: "#5e824a" },
  ];
  // Synthetic 4×4 bitmap, all desert.
  const w = 4, h = 4;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    pixels[i * 4] = 0xd4; pixels[i * 4 + 1] = 0xa3; pixels[i * 4 + 2] = 0x73; pixels[i * 4 + 3] = 255;
  }
  writeBuffer(builder, (d) => {
    d.pixels = pixels;
    d.width = w;
    d.height = h;
    d.palette = palette;
    d.activeId = "desert";
    d.bootstrapped = true;
    d.history = [{ pixels: new Uint8ClampedArray(pixels) }];
    d.historyIndex = 0;
  });

  const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
  const g = buildExecutionGraph({
    id: "g",
    nodes: ["stateMachineSystem", "builderInputSystem", "builderSystem"],
    registry: reg,
  });
  return { reg, acc, builder, events, sm, g };
}

function tick(reg: ReturnType<typeof setup>["reg"], g: ReturnType<typeof setup>["g"]) {
  executeGraph(g, reg, { dt: 0, now: 0 });
}

describe("BuilderSystem — event handling", () => {
  it("PaletteSelect updates activeId", () => {
    const { reg, acc, builder, g } = setup();
    acc.events.push({ type: "PaletteSelect", id: "water" });
    tick(reg, g);
    expect(readBuffer(builder).activeId).toBe("water");
  });

  it("BrushToolSet switches between paint and fill", () => {
    const { reg, acc, builder, g } = setup();
    acc.events.push({ type: "BrushToolSet", tool: "fill" });
    tick(reg, g);
    expect(readBuffer(builder).brushTool).toBe("fill");
  });

  it("PaletteAdd adds an entry with a non-clashing color", () => {
    const { reg, acc, builder, g } = setup();
    const before = readBuffer(builder).palette.length;
    acc.events.push({ type: "PaletteAdd", id: "shanty", kind: "asset" });
    tick(reg, g);
    const after = readBuffer(builder);
    expect(after.palette.length).toBe(before + 1);
    expect(after.palette.some((e) => e.id === "shanty")).toBe(true);
    expect(after.activeId).toBe("shanty");
  });

  it("PaletteRecolor records error on color clash, no mutation", () => {
    const { reg, acc, builder, g } = setup();
    acc.events.push({ type: "PaletteRecolor", id: "desert", color: "#3b6e8f" }); // clashes with water
    tick(reg, g);
    const b = readBuffer(builder);
    expect(b.errorMessage).toContain("clashes");
    expect(b.palette.find((e) => e.id === "desert")?.color).toBe("#d4a373"); // unchanged
  });

  it("FloodFill replaces a connected region", () => {
    const { reg, acc, builder, g } = setup();
    // Active is desert; switch to water and fill at (0,0)
    acc.events.push({ type: "PaletteSelect", id: "water" });
    acc.events.push({ type: "BrushToolSet", tool: "fill" });
    acc.events.push({ type: "FloodFill", x: 0, y: 0 });
    tick(reg, g);
    const b = readBuffer(builder);
    // All pixels should now be water (#3b6e8f)
    for (let i = 0; i < 16; i++) {
      expect(b.pixels[i * 4]).toBe(0x3b);
      expect(b.pixels[i * 4 + 1]).toBe(0x6e);
      expect(b.pixels[i * 4 + 2]).toBe(0x8f);
    }
  });

  it("Undo restores the bitmap before a flood fill", () => {
    const { reg, acc, builder, g } = setup();
    const before = new Uint8ClampedArray(readBuffer(builder).pixels);
    acc.events.push({ type: "PaletteSelect", id: "water" });
    acc.events.push({ type: "BrushToolSet", tool: "fill" });
    acc.events.push({ type: "FloodFill", x: 0, y: 0 });
    tick(reg, g);
    acc.events.push({ type: "Undo" });
    tick(reg, g);
    const after = readBuffer(builder).pixels;
    expect(Array.from(after)).toEqual(Array.from(before));
  });

  it("SendToWorld emits RebuildRequested + ModeRequested(world)", () => {
    const { reg, acc, events, g } = setup();
    acc.events.push({ type: "SendToWorld" });
    tick(reg, g);
    const evs = readBuffer(events);
    const types = evs.map((e) => e.type);
    expect(types).toContain("RebuildRequested");
    expect(types).toContain("ModeRequested");
    const rebuild = evs.find((e) => e.type === "RebuildRequested");
    if (rebuild?.type === "RebuildRequested") {
      expect(rebuild.payload.sceneName).toMatch(/^painted-/);
      expect(rebuild.payload.scene.labels.length).toBe(3);
    }
  });

  it("SendToWorld with duplicate-color palette reports error and does not emit", () => {
    const { reg, acc, builder, events, g } = setup();
    writeBuffer(builder, (d) => {
      d.palette = [
        { kind: "terrain", id: "desert", color: "#d4a373" },
        { kind: "terrain", id: "water", color: "#d4a373" }, // dup
      ];
    });
    acc.events.push({ type: "SendToWorld" });
    tick(reg, g);
    expect(readBuffer(builder).errorMessage).toContain("duplicate");
    expect(readBuffer(events).length).toBe(0);
  });
});
