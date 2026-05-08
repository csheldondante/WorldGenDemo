import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../../src/buffers/stateMachine";
import { EVENT_BUFFER_ID, type RuntimeEvent } from "../../src/buffers/event";
import { TIMING_BUFFER_ID, type TimingBufferData } from "../../src/buffers/timing";
import { createLoadSceneSystem } from "../../src/systems/loadScene";
import { AssetCatalog } from "../../src/assets/catalog";

beforeEach(() => {
  AssetCatalog.reset();
  AssetCatalog.register({
    id: "cactus",
    generate: () => null as any,
    placement: { multiplicity: "fill", on_terrain: ["desert"] },
  });
});

function setupReg() {
  const reg = createRegistry();
  registerCoreBuffers(reg);
  reg.registerSystem(createLoadSceneSystem());
  const sm = reg.getBuffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID);
  const events = reg.getBuffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
  const timing = reg.getBuffer<TimingBufferData>(TIMING_BUFFER_ID);
  return { reg, sm, events, timing };
}

function runGraphOnce(reg: ReturnType<typeof setupReg>["reg"]) {
  const g = buildExecutionGraph({ id: "g", nodes: ["loadSceneSystem"], registry: reg });
  executeGraph(g, reg, { dt: 0, now: 0 });
}

describe("LoadSceneSystem", () => {
  it("does nothing when not in Loading state", async () => {
    const { reg, sm, events } = setupReg();
    writeBuffer(sm, (d) => { d.state = "Running"; d.activeGraph = "Running"; });
    runGraphOnce(reg);
    expect(readBuffer(events).length).toBe(0);
  });

  it("does nothing when pendingLoad is null", async () => {
    const { reg, events } = setupReg();
    // sm state defaults to Loading; pendingLoad is null
    runGraphOnce(reg);
    expect(readBuffer(events).length).toBe(0);
  });

  it("emits RebuildRequested when fetch resolves successfully", async () => {
    const { reg, sm, events } = setupReg();
    writeBuffer(sm, (d) => { d.pendingLoad = { sceneName: "tiny" }; });

    // Mock fetch + Image. The system uses loadScene() which uses fetch + new Image()
    const sceneJson = JSON.stringify({
      name: "tiny", tileSize: 1,
      labels: [{ color: "#d4a373", kind: "terrain", terrain: "desert" }],
    });
    const _fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("scene.json")) {
        return { ok: true, json: async () => JSON.parse(sceneJson) } as unknown as Response;
      }
      return { ok: false } as unknown as Response;
    });
    vi.stubGlobal("fetch", _fetchMock);

    // Stub Image and document so loadScene can construct one
    const fakeImg: any = { naturalWidth: 1, naturalHeight: 1, onload: null, onerror: null, crossOrigin: "" };
    Object.defineProperty(fakeImg, "src", {
      set() { setTimeout(() => fakeImg.onload?.(), 0); },
    });
    vi.stubGlobal("Image", function () { return fakeImg; });
    const fakeCanvas: any = {
      width: 0, height: 0,
      getContext: () => ({
        imageSmoothingEnabled: false,
        drawImage: () => {},
        getImageData: () => ({ data: new Uint8ClampedArray([0xd4, 0xa3, 0x73, 255]) }),
      }),
    };
    vi.stubGlobal("document", { createElement: () => fakeCanvas } as unknown as Document);

    runGraphOnce(reg); // first tick: kicks off fetch
    expect(readBuffer(events).length).toBe(0);

    // Wait microtasks + a task tick so the promise resolves
    await new Promise((r) => setTimeout(r, 5));

    runGraphOnce(reg); // second tick: should now see the resolved result and emit
    const out = readBuffer(events);
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("RebuildRequested");
    if (out[0].type === "RebuildRequested") {
      expect(out[0].payload.sceneName).toBe("tiny");
      expect(out[0].payload.width).toBe(1);
    }
    vi.unstubAllGlobals();
  });

  it("records error to TimingBuffer when fetch fails", async () => {
    const { reg, sm, timing } = setupReg();
    writeBuffer(sm, (d) => { d.pendingLoad = { sceneName: "missing" }; });

    const _fetchMock = vi.fn(async () => ({ ok: false } as unknown as Response));
    vi.stubGlobal("fetch", _fetchMock);

    runGraphOnce(reg);
    await new Promise((r) => setTimeout(r, 5));
    runGraphOnce(reg);

    const t = readBuffer(timing);
    expect(t.warnings.some((w) => w.startsWith("load failed"))).toBe(true);
    vi.unstubAllGlobals();
  });
});
