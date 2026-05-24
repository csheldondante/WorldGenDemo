/**
 * serializeMode + restoreMode round-trip integration test. Covers the
 * shape contract that the CLI scripts (scripts/saveMode.ts +
 * scripts/loadMode.ts) rely on: a snapshot from one registry
 * round-trips cleanly into another registry's buffers.
 *
 * Unit tests for the snapshot encoding live in tests/runtime/modeSnapshot.test.ts;
 * this test exercises the full lifecycle (= the Phase 7b CLI flow).
 */

import { describe, it, expect } from "vitest";
import { createRegistry, type Registry } from "../../src/runtime/registry";
import { createBuffer, readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { serializeMode, restoreMode } from "../../src/runtime/modeSnapshot";

function setup(): Registry {
  const reg = createRegistry();
  reg.registerBuffer(createBuffer<{ score: number; players: Map<string, number> }>({
    id: "gameState",
    description: "test buffer with a Map (= round-trips via the snapshot encoder)",
    initial: { score: 0, players: new Map() },
  }));
  reg.registerBuffer(createBuffer<{ palette: string[] }>({
    id: "palette",
    description: "test buffer with an array",
    initial: { palette: ["red", "blue"] },
  }));
  reg.registerMode({
    id: "TestMode",
    label: "Test",
    tags: ["test"],
    systems: [],
    ownedBuffers: ["gameState"],
    sharedBuffers: ["palette"],
  });
  return reg;
}

describe("Phase 7b — serializeMode + restoreMode round-trip", () => {
  it("captures owned + shared buffer state and restores to a fresh registry", () => {
    const src = setup();
    writeBuffer(src.getBuffer<{ score: number; players: Map<string, number> }>("gameState"), (d) => {
      d.score = 42;
      d.players.set("alice", 10);
      d.players.set("bob", 7);
    });
    writeBuffer(src.getBuffer<{ palette: string[] }>("palette"), (d) => {
      d.palette = ["yellow", "green", "purple"];
    });
    const snapshot = serializeMode(src, "TestMode");
    expect(snapshot.modeId).toBe("TestMode");
    expect(Object.keys(snapshot.buffers).sort()).toEqual(["gameState", "palette"]);

    // Round-trip through JSON to verify it's actually serializable.
    const json = JSON.stringify(snapshot);
    const parsed = JSON.parse(json);
    const dst = setup();
    restoreMode(dst, parsed);
    const gs = readBuffer(dst.getBuffer<{ score: number; players: Map<string, number> }>("gameState"));
    expect(gs.score).toBe(42);
    expect(gs.players.size).toBe(2);
    expect(gs.players.get("alice")).toBe(10);
    expect(gs.players.get("bob")).toBe(7);
    const pal = readBuffer(dst.getBuffer<{ palette: string[] }>("palette"));
    expect(pal.palette).toEqual(["yellow", "green", "purple"]);
  });

  it("restore silently skips snapshot entries for buffers not in target registry (= forward-compat)", () => {
    const src = setup();
    const snapshot = serializeMode(src, "TestMode");
    // Mutate the snapshot to include a stale buffer id.
    snapshot.buffers["nonexistent"] = { foo: "bar" } as never;
    const dst = setup();
    expect(() => restoreMode(dst, snapshot)).not.toThrow();
  });

  it("excludeFromSnapshot fields appear in `excluded` and are NOT in `buffers`", () => {
    const reg = createRegistry();
    reg.registerBuffer(createBuffer<{ n: number }>({
      id: "kept", description: "test", initial: { n: 1 },
    }));
    reg.registerBuffer(createBuffer<{ ref: object }>({
      id: "renderHandle", description: "non-serializable", initial: { ref: {} },
    }));
    reg.registerMode({
      id: "WithExcluded",
      label: "WithExcluded",
      tags: [],
      systems: [],
      ownedBuffers: ["kept", "renderHandle"],
      excludeFromSnapshot: ["renderHandle"],
    });
    const snapshot = serializeMode(reg, "WithExcluded");
    expect(Object.keys(snapshot.buffers)).toEqual(["kept"]);
    expect(snapshot.excluded).toEqual(["renderHandle"]);
  });
});
