import { describe, it, expect, vi } from "vitest";
import { Fsm } from "../../src/lib/stateMachine";

type S = "Idle" | "Running" | "Paused";
type E =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reset" }
  | { type: "withGuard"; allow: boolean };

function fresh(): Fsm<S, E> {
  return new Fsm<S, E>("Idle");
}

describe("Fsm", () => {
  it("starts in the initial state", () => {
    expect(fresh().state).toBe("Idle");
  });

  it("transitions on a matching event", () => {
    const m = fresh();
    m.addTransition({ from: "Idle", on: "start", to: "Running" });
    const r = m.dispatch({ type: "start" });
    expect(r.transitioned).toBe(true);
    expect(r.from).toBe("Idle");
    expect(r.to).toBe("Running");
    expect(m.state).toBe("Running");
  });

  it("returns transitioned: false on unhandled events", () => {
    const m = fresh();
    m.addTransition({ from: "Idle", on: "start", to: "Running" });
    const r = m.dispatch({ type: "pause" });
    expect(r.transitioned).toBe(false);
    expect(m.state).toBe("Idle");
  });

  it("supports the wildcard from: '*'", () => {
    const m = fresh();
    m.addTransition({ from: "*", on: "reset", to: "Idle" });
    m.addTransition({ from: "Idle", on: "start", to: "Running" });
    m.dispatch({ type: "start" });
    expect(m.state).toBe("Running");
    m.dispatch({ type: "reset" });
    expect(m.state).toBe("Idle");
  });

  it("guards reject transitions", () => {
    const m = fresh();
    m.addTransition({
      from: "Idle",
      on: "withGuard",
      to: "Running",
      guard: (e) => e.type === "withGuard" && e.allow,
    });
    const r1 = m.dispatch({ type: "withGuard", allow: false });
    expect(r1.transitioned).toBe(false);
    expect(m.state).toBe("Idle");

    const r2 = m.dispatch({ type: "withGuard", allow: true });
    expect(r2.transitioned).toBe(true);
    expect(m.state).toBe("Running");
  });

  it("first matching transition wins (in declaration order)", () => {
    const m = fresh();
    m.addTransition({
      from: "Idle",
      on: "withGuard",
      to: "Running",
      guard: (e) => e.type === "withGuard" && !e.allow,
    });
    m.addTransition({ from: "Idle", on: "withGuard", to: "Paused" });
    m.dispatch({ type: "withGuard", allow: true });
    expect(m.state).toBe("Paused");
  });

  it("fires onLeave then onEnter when transitioning", () => {
    const m = fresh();
    m.addTransition({ from: "Idle", on: "start", to: "Running" });
    const order: string[] = [];
    m.onLeave("Idle", () => order.push("leave-Idle"));
    m.onEnter("Running", () => order.push("enter-Running"));
    m.dispatch({ type: "start" });
    expect(order).toEqual(["leave-Idle", "enter-Running"]);
  });

  it("does not fire hooks for self-transitions when from !== to but the same handler ID", () => {
    const m = fresh();
    m.addTransition({ from: "*", on: "start", to: "Idle" }); // Idle -> Idle (no-op)
    const enter = vi.fn();
    const leave = vi.fn();
    m.onEnter("Idle", enter);
    m.onLeave("Idle", leave);
    m.dispatch({ type: "start" });
    // No transition occurred (from === to is treated as no-op here)
    expect(enter).not.toHaveBeenCalled();
    expect(leave).not.toHaveBeenCalled();
  });

  it("can() reports whether an event would transition", () => {
    const m = fresh();
    m.addTransition({ from: "Idle", on: "start", to: "Running" });
    expect(m.can({ type: "start" })).toBe(true);
    expect(m.can({ type: "pause" })).toBe(false);
  });

  it("history records transitions in order", () => {
    const m = fresh();
    m.addTransition({ from: "Idle", on: "start", to: "Running" });
    m.addTransition({ from: "Running", on: "pause", to: "Paused" });
    m.addTransition({ from: "Paused", on: "resume", to: "Running" });
    m.dispatch({ type: "start" });
    m.dispatch({ type: "pause" });
    m.dispatch({ type: "resume" });
    const h = m.history();
    expect(h.map((x) => x.via)).toEqual(["start", "pause", "resume"]);
    expect(h.map((x) => x.to)).toEqual(["Running", "Paused", "Running"]);
  });

  it("history is bounded to the configured size", () => {
    const m = new Fsm<S, E>("Idle", { historyLimit: 3 });
    m.addTransition({ from: "*", on: "start", to: "Running" });
    m.addTransition({ from: "*", on: "reset", to: "Idle" });
    for (let i = 0; i < 10; i++) {
      m.dispatch({ type: "start" });
      m.dispatch({ type: "reset" });
    }
    expect(m.history().length).toBeLessThanOrEqual(3);
  });

  it("onUnhandled fires with reason='unmatched' when no rule matches", () => {
    const seen: any[] = [];
    const m = new Fsm<S, E>("Idle", { onUnhandled: (info) => seen.push(info) });
    m.addTransition({ from: "Idle", on: "start", to: "Running" });
    m.dispatch({ type: "pause" }); // no rule
    expect(seen.length).toBe(1);
    expect(seen[0].reason).toBe("unmatched");
    expect(seen[0].state).toBe("Idle");
  });

  it("onUnhandled fires with reason='self-transition' when to===from", () => {
    const seen: any[] = [];
    const m = new Fsm<S, E>("Idle", { onUnhandled: (info) => seen.push(info) });
    m.addTransition({ from: "*", on: "start", to: "Idle" }); // Idle->Idle
    m.dispatch({ type: "start" });
    expect(seen.length).toBe(1);
    expect(seen[0].reason).toBe("self-transition");
  });

  it("onUnhandled does not fire on a real transition", () => {
    const seen: any[] = [];
    const m = new Fsm<S, E>("Idle", { onUnhandled: (info) => seen.push(info) });
    m.addTransition({ from: "Idle", on: "start", to: "Running" });
    m.dispatch({ type: "start" });
    expect(seen.length).toBe(0);
  });

  it("effect runs on transition", () => {
    const m = fresh();
    const effect = vi.fn();
    m.addTransition({ from: "Idle", on: "start", to: "Running", effect });
    m.dispatch({ type: "start" });
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
