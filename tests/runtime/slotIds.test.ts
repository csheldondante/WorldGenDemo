import { describe, it, expect } from "vitest";
import {
  SLOT_INPUT_NORMALIZATION,
  SLOT_INPUT_SEMANTIC_MAPPING,
  SLOT_CAMERA_INTENT,
  SLOT_CHARACTER_INTENT,
  SLOT_CAMERA_UPDATE,
  SLOT_COLLISION,
  SLOT_CHARACTER_UPDATE,
  SLOT_PHYSICS,
  SLOT_ANIMATION,
  CANONICAL_SLOT_ORDER,
  isValidSlotId,
} from "../../src/runtime/slotIds";

describe("Canonical slot ids", () => {
  it("exports all 9 slot ids as string constants", () => {
    const slots = [
      SLOT_INPUT_NORMALIZATION,
      SLOT_INPUT_SEMANTIC_MAPPING,
      SLOT_CAMERA_INTENT,
      SLOT_CHARACTER_INTENT,
      SLOT_CAMERA_UPDATE,
      SLOT_COLLISION,
      SLOT_CHARACTER_UPDATE,
      SLOT_PHYSICS,
      SLOT_ANIMATION,
    ];
    for (const s of slots) {
      expect(typeof s).toBe("string");
      expect(s.length).toBeGreaterThan(0);
    }
    expect(new Set(slots).size).toBe(slots.length);  // all distinct
  });

  it("CANONICAL_SLOT_ORDER contains every slot exactly once in tick-flow order", () => {
    expect(CANONICAL_SLOT_ORDER).toEqual([
      SLOT_INPUT_NORMALIZATION,
      SLOT_INPUT_SEMANTIC_MAPPING,
      SLOT_CAMERA_INTENT,
      SLOT_CHARACTER_INTENT,
      SLOT_CAMERA_UPDATE,
      SLOT_COLLISION,
      SLOT_CHARACTER_UPDATE,
      SLOT_PHYSICS,
      SLOT_ANIMATION,
    ]);
  });

  it("isValidSlotId(canonical) is true; other strings are false", () => {
    for (const slot of CANONICAL_SLOT_ORDER) {
      expect(isValidSlotId(slot)).toBe(true);
    }
    expect(isValidSlotId("not-a-slot")).toBe(false);
    expect(isValidSlotId("")).toBe(false);
    expect(isValidSlotId("characterintent")).toBe(false); // case-sensitive
  });
});
