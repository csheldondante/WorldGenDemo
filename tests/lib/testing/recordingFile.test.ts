import { describe, it, expect } from "vitest";
import {
  tagInfinity,
  untagInfinity,
  snapshotBufferForRecording,
  restoreBufferFromRecording,
  defaultRecordingFilename,
} from "../../../src/lib/testing/recordingFile";

describe("recordingFile — Infinity tagging", () => {
  it("primitives round-trip", () => {
    expect(untagInfinity(tagInfinity(1))).toBe(1);
    expect(untagInfinity(tagInfinity(0))).toBe(0);
    expect(untagInfinity(tagInfinity(-3.14))).toBe(-3.14);
    expect(untagInfinity(tagInfinity("hello"))).toBe("hello");
    expect(untagInfinity(tagInfinity(true))).toBe(true);
    expect(untagInfinity(tagInfinity(null))).toBe(null);
  });

  it("Infinity ↔ sentinel", () => {
    expect(tagInfinity(Infinity)).toBe("__inf__");
    expect(tagInfinity(-Infinity)).toBe("__neginf__");
    expect(untagInfinity("__inf__")).toBe(Infinity);
    expect(untagInfinity("__neginf__")).toBe(-Infinity);
  });

  it("nested objects + arrays round-trip with Infinity", () => {
    const live = {
      curve: { accelAtZero: 30, vMax: Infinity },
      nested: { deep: { negCap: -Infinity, ok: 7 } },
      list: [1, Infinity, -Infinity, 0],
    };
    const tagged = tagInfinity(live);
    const restored = untagInfinity(tagged) as typeof live;
    expect(restored.curve.vMax).toBe(Infinity);
    expect(restored.nested.deep.negCap).toBe(-Infinity);
    expect(restored.list).toEqual([1, Infinity, -Infinity, 0]);
    expect(restored.curve.accelAtZero).toBe(30);
  });

  it("Maps and Sets carry through", () => {
    const live = new Map<string, unknown>([
      ["a", { vMax: Infinity }],
      ["b", new Set([1, Infinity])],
    ]);
    const tagged = tagInfinity(live) as Map<string, unknown>;
    const restored = untagInfinity(tagged) as Map<string, unknown>;
    expect(restored.get("a")).toEqual({ vMax: Infinity });
    const s = restored.get("b") as Set<number>;
    expect(Array.from(s).sort((a, b) => a - b)).toEqual([1, Infinity]);
  });
});

describe("recordingFile — snapshotBufferForRecording / restore", () => {
  it("plain buffer data round-trips identically (modulo Set sort order)", () => {
    const live = {
      byEntity: new Map<number, { position: [number, number, number] }>([
        [1, { position: [0, 0.5, 0] }],
        [2, { position: [10, 1.2, -3] }],
      ]),
    };
    const snap = snapshotBufferForRecording(live);
    const restored = restoreBufferFromRecording(snap) as typeof live;
    expect(restored.byEntity.size).toBe(2);
    expect(restored.byEntity.get(1)).toEqual({ position: [0, 0.5, 0] });
    expect(restored.byEntity.get(2)).toEqual({ position: [10, 1.2, -3] });
  });

  it("profile-shaped data with Infinity round-trips", () => {
    const live = {
      byId: new Map<string, unknown>([
        [
          "player",
          {
            id: "player",
            name: "player",
            forwardAccel: { accelAtZero: 40, vMax: 8 },
            upAccel: { accelAtZero: 5, vMax: Infinity },
            downAccel: { accelAtZero: 0, vMax: Infinity },
            climb: {
              forwardAccel: { accelAtZero: 30, vMax: 2 },
              downAccel: { accelAtZero: 20, vMax: Infinity },
            },
          },
        ],
      ]),
    };
    const snap = snapshotBufferForRecording(live);
    const restored = restoreBufferFromRecording(snap) as typeof live;
    const player = restored.byId.get("player") as {
      forwardAccel: { vMax: number };
      upAccel: { vMax: number };
      climb: { downAccel: { vMax: number } };
    };
    expect(player.forwardAccel.vMax).toBe(8);
    expect(player.upAccel.vMax).toBe(Infinity);
    expect(player.climb.downAccel.vMax).toBe(Infinity);
  });

  it("JSON serialize → parse → restore is byte-stable for plain shapes", () => {
    const live = { byEntity: new Map<number, { vy: number }>([[1, { vy: -9.81 }]]) };
    const snap = snapshotBufferForRecording(live);
    const wire = JSON.parse(JSON.stringify(snap));
    const restored = restoreBufferFromRecording(wire) as typeof live;
    expect(restored.byEntity.get(1)).toEqual({ vy: -9.81 });
  });
});

describe("recordingFile — defaultRecordingFilename", () => {
  it("includes the scene stem + .recording.json", () => {
    const name = defaultRecordingFilename("gym-climb-tall");
    expect(name).toMatch(/^gym-climb-tall-/);
    expect(name).toMatch(/\.recording\.json$/);
  });

  it("null scene falls back to 'recording'", () => {
    const name = defaultRecordingFilename(null);
    expect(name).toMatch(/^recording-/);
  });

  it("filesystem-unsafe characters in scene name are sanitized", () => {
    const name = defaultRecordingFilename("foo/bar*baz?");
    expect(name.includes("/")).toBe(false);
    expect(name.includes("*")).toBe(false);
    expect(name.includes("?")).toBe(false);
  });

  it("no colons in the timestamp (Windows-safe)", () => {
    const name = defaultRecordingFilename("scene");
    expect(name.includes(":")).toBe(false);
  });
});
