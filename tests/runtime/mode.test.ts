import { describe, it, expect } from "vitest";
import { createModeRegistry, type Mode } from "../../src/runtime/mode";

/**
 * Phase 1 of the modes-and-modules refactor: ModeRegistry is the new
 * top-level abstraction over (active buffer set, active system graph).
 *
 * In this phase we only verify the registry's basic shape — register,
 * lookup, list, filter. Subsequent phases switch `StateMachineBuffer`
 * from `activeGraph` (= hardcoded enum) to `activeMode` (= registry
 * lookup), and the graph regenerates from `mode.systems` via
 * `buildExecutionGraph`.
 *
 * See `docs/modes-and-modules.md` for the full architectural target.
 */
describe("ModeRegistry", () => {
  it("registers and retrieves modes by id", () => {
    const reg = createModeRegistry();
    const mode: Mode = { id: "test", label: "Test Mode", systems: ["a", "b"] };
    reg.register(mode);
    expect(reg.get("test")).toBe(mode);
    expect(reg.has("test")).toBe(true);
  });

  it("rejects duplicate registrations", () => {
    const reg = createModeRegistry();
    reg.register({ id: "x", label: "X", systems: [] });
    expect(() => reg.register({ id: "x", label: "Y", systems: [] })).toThrow(/already registered/);
  });

  it("returns undefined / false for unknown ids", () => {
    const reg = createModeRegistry();
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.has("nope")).toBe(false);
  });

  it("lists all registered modes", () => {
    const reg = createModeRegistry();
    reg.register({ id: "a", label: "A", systems: [] });
    reg.register({ id: "b", label: "B", systems: [] });
    expect(reg.list().map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  it("filters list by tag (all-of)", () => {
    const reg = createModeRegistry();
    reg.register({ id: "a", label: "A", systems: [], tags: ["scene"] });
    reg.register({ id: "b", label: "B", systems: [], tags: ["debug"] });
    reg.register({ id: "c", label: "C", systems: [], tags: ["scene", "debug"] });
    expect(reg.list({ tags: ["scene"] }).map((m) => m.id).sort()).toEqual(["a", "c"]);
    expect(reg.list({ tags: ["debug"] }).map((m) => m.id).sort()).toEqual(["b", "c"]);
    expect(reg.list({ tags: ["scene", "debug"] }).map((m) => m.id)).toEqual(["c"]);
  });

  it("filters list by search (substring match in id or label, case-insensitive)", () => {
    const reg = createModeRegistry();
    reg.register({ id: "loading-scene", label: "Loading Scene", systems: [] });
    reg.register({ id: "running", label: "Running", systems: [] });
    expect(reg.list({ search: "load" }).map((m) => m.id)).toEqual(["loading-scene"]);
    expect(reg.list({ search: "RUN" }).map((m) => m.id)).toEqual(["running"]);
    expect(reg.list({ search: "scene" }).map((m) => m.id)).toEqual(["loading-scene"]);
  });

  it("returns an independent array from list() — caller mutations don't affect future calls", () => {
    const reg = createModeRegistry();
    reg.register({ id: "a", label: "A", systems: [] });
    const list1 = reg.list();
    list1.push({ id: "fake", label: "Fake", systems: [] });
    list1.length = 0;
    expect(reg.list().map((m) => m.id)).toEqual(["a"]);
  });
});
