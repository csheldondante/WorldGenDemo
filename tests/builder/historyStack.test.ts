import { describe, it, expect } from "vitest";
import {
  emptyHistory,
  pushHistory,
  undo,
  redo,
  currentFrame,
  canUndo,
  canRedo,
} from "../../src/builder/historyStack";
import { HISTORY_LIMIT } from "../../src/buffers/builder";

function frame(byte: number) {
  return { pixels: new Uint8ClampedArray([byte]) };
}

describe("historyStack", () => {
  it("starts empty", () => {
    const s = emptyHistory();
    expect(currentFrame(s)).toBeNull();
    expect(canUndo(s)).toBe(false);
    expect(canRedo(s)).toBe(false);
  });

  it("push/undo/redo round-trip", () => {
    let s = emptyHistory();
    s = pushHistory(s, frame(1));
    s = pushHistory(s, frame(2));
    s = pushHistory(s, frame(3));
    expect(currentFrame(s)?.pixels[0]).toBe(3);

    s = undo(s);
    expect(currentFrame(s)?.pixels[0]).toBe(2);
    s = undo(s);
    expect(currentFrame(s)?.pixels[0]).toBe(1);
    expect(canUndo(s)).toBe(false);

    s = redo(s);
    expect(currentFrame(s)?.pixels[0]).toBe(2);
    s = redo(s);
    expect(currentFrame(s)?.pixels[0]).toBe(3);
    expect(canRedo(s)).toBe(false);
  });

  it("pushing after undo discards the redo tail", () => {
    let s = emptyHistory();
    s = pushHistory(s, frame(1));
    s = pushHistory(s, frame(2));
    s = pushHistory(s, frame(3));
    s = undo(s);
    s = undo(s);
    expect(currentFrame(s)?.pixels[0]).toBe(1);
    s = pushHistory(s, frame(99)); // diverges
    expect(currentFrame(s)?.pixels[0]).toBe(99);
    expect(canRedo(s)).toBe(false);
  });

  it(`caps at HISTORY_LIMIT (${HISTORY_LIMIT})`, () => {
    let s = emptyHistory();
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
      s = pushHistory(s, frame(i));
    }
    expect(s.history.length).toBe(HISTORY_LIMIT);
    // The current frame should be the most recent push.
    expect(currentFrame(s)?.pixels[0]).toBe(HISTORY_LIMIT + 9);
  });
});
