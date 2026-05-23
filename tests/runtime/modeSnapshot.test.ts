import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { serializeMode, restoreMode } from "../../src/runtime/modeSnapshot";

/**
 * Phase 7: mode-level state snapshotting. `serializeMode(reg, modeId)`
 * captures the current buffer state for every buffer the mode declares
 * (via ownedBuffers + sharedBuffers) into a JSON-shaped tree.
 * `restoreMode(reg, snapshot)` applies the captured state back into
 * the registry's buffers.
 *
 * Built on the existing buffer-snapshot encoder in
 * `src/lib/testing/bufferSnapshot.ts`. Mode-level wrapper iterates
 * mode-declared buffers and applies the encoder per-buffer.
 *
 * Use cases (long arc):
 *   - Save game = serializeMode + write JSON to disk.
 *   - Load game = read JSON + restoreMode.
 *   - Editor save / scene replay / undo step. Hot transition between
 *     modes that share projected character state.
 */
describe("serializeMode / restoreMode", () => {
  it("round-trips a single owned buffer's data", () => {
    const reg = createRegistry();
    const buf = createBuffer<{ counter: number; tag: string }>({
      id: "test-buf",
      description: "",
      initial: { counter: 0, tag: "init" },
    });
    reg.registerBuffer(buf);
    reg.registerMode({
      id: "test-mode",
      label: "Test",
      systems: [],
      ownedBuffers: ["test-buf"],
    });

    writeBuffer(buf, (d) => { d.counter = 42; d.tag = "captured"; });
    const snapshot = serializeMode(reg, "test-mode");

    // Mutate buffer state away from the snapshot.
    writeBuffer(buf, (d) => { d.counter = -1; d.tag = "dirty"; });

    restoreMode(reg, snapshot);
    expect(readBuffer(buf).counter).toBe(42);
    expect(readBuffer(buf).tag).toBe("captured");
  });

  it("captures both ownedBuffers and sharedBuffers", () => {
    const reg = createRegistry();
    const owned = createBuffer<{ x: number }>({ id: "owned-b", description: "", initial: { x: 1 } });
    const shared = createBuffer<{ y: number }>({ id: "shared-b", description: "", initial: { y: 10 } });
    reg.registerBuffer(owned);
    reg.registerBuffer(shared);
    reg.registerMode({
      id: "m",
      label: "M",
      systems: [],
      ownedBuffers: ["owned-b"],
      sharedBuffers: ["shared-b"],
    });

    writeBuffer(owned, (d) => { d.x = 5; });
    writeBuffer(shared, (d) => { d.y = 50; });

    const snap = serializeMode(reg, "m");
    expect(Object.keys(snap.buffers).sort()).toEqual(["owned-b", "shared-b"]);
  });

  it("produces a JSON-serializable snapshot", () => {
    const reg = createRegistry();
    const buf = createBuffer<{ items: number[] }>({
      id: "b",
      description: "",
      initial: { items: [1, 2, 3] },
    });
    reg.registerBuffer(buf);
    reg.registerMode({ id: "m", label: "M", systems: [], ownedBuffers: ["b"] });
    const snap = serializeMode(reg, "m");
    expect(() => JSON.stringify(snap)).not.toThrow();
    const round = JSON.parse(JSON.stringify(snap));
    expect(round).toEqual(snap);
  });

  it("snapshot.modeId carries the source mode's id", () => {
    const reg = createRegistry();
    const buf = createBuffer<{ x: number }>({ id: "b", description: "", initial: { x: 0 } });
    reg.registerBuffer(buf);
    reg.registerMode({ id: "the-mode", label: "M", systems: [], ownedBuffers: ["b"] });
    const snap = serializeMode(reg, "the-mode");
    expect(snap.modeId).toBe("the-mode");
  });

  it("throws on unknown mode id", () => {
    const reg = createRegistry();
    expect(() => serializeMode(reg, "nope")).toThrow(/mode/i);
  });

  it("excludes buffers in mode.excludeFromSnapshot (e.g. render handles)", () => {
    const reg = createRegistry();
    const a = createBuffer<{ x: number }>({ id: "a", description: "", initial: { x: 1 } });
    const b = createBuffer<{ y: number }>({ id: "b", description: "", initial: { y: 2 } });
    reg.registerBuffer(a);
    reg.registerBuffer(b);
    reg.registerMode({
      id: "m",
      label: "M",
      systems: [],
      ownedBuffers: ["a", "b"],
      excludeFromSnapshot: ["b"],
    });
    const snap = serializeMode(reg, "m");
    expect(Object.keys(snap.buffers)).toEqual(["a"]);
    expect(snap.excluded).toContain("b");
  });

  it("restoreMode skips buffers not present in the registry (= forward-compat)", () => {
    const reg = createRegistry();
    const buf = createBuffer<{ x: number }>({ id: "present", description: "", initial: { x: 0 } });
    reg.registerBuffer(buf);
    reg.registerMode({ id: "m", label: "M", systems: [], ownedBuffers: ["present"] });
    const snapshot = {
      modeId: "m",
      buffers: { "present": { x: 99 }, "absent": { y: 0 } },
      excluded: [],
    };
    expect(() => restoreMode(reg, snapshot)).not.toThrow();
    expect(readBuffer(buf).x).toBe(99);
  });
});
