/**
 * Generic finite state machine.
 *
 * Runtime-agnostic: must not import from src/runtime/ or src/systems/.
 *
 * Used by the runtime's StateMachineSystem, but also useful for any modal
 * logic (UI flows, AI behaviors, animation states).
 */

export interface Transition<S extends string, E extends { type: string }> {
  from: S | "*";
  on: E["type"];
  to: S;
  guard?: (event: E, currentState: S) => boolean;
  effect?: (event: E, transition: { from: S; to: S }) => void;
}

export interface FsmHistoryEntry<S extends string, T extends string> {
  at: number;
  from: S;
  to: S;
  via: T;
}

export interface FsmOptions {
  /** Maximum number of history entries kept; older entries are dropped. */
  historyLimit?: number;
}

export class Fsm<S extends string, E extends { type: string }> {
  state: S;
  private readonly transitions: Transition<S, E>[] = [];
  private readonly enterHooks = new Map<S, Array<(from: S) => void>>();
  private readonly leaveHooks = new Map<S, Array<(to: S) => void>>();
  private readonly _history: FsmHistoryEntry<S, E["type"]>[] = [];
  private readonly historyLimit: number;

  constructor(initial: S, options: FsmOptions = {}) {
    this.state = initial;
    this.historyLimit = options.historyLimit ?? 64;
  }

  addTransition(t: Transition<S, E>): void {
    this.transitions.push(t);
  }

  /**
   * Returns an unsubscribe function.
   */
  onEnter(s: S, fn: (from: S) => void): () => void {
    const arr = this.enterHooks.get(s) ?? [];
    arr.push(fn);
    this.enterHooks.set(s, arr);
    return () => {
      const a = this.enterHooks.get(s);
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };
  }

  onLeave(s: S, fn: (to: S) => void): () => void {
    const arr = this.leaveHooks.get(s) ?? [];
    arr.push(fn);
    this.leaveHooks.set(s, arr);
    return () => {
      const a = this.leaveHooks.get(s);
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };
  }

  /**
   * Returns the matching transition, or null. First match wins (declaration order).
   */
  private match(event: E, state: S): Transition<S, E> | null {
    for (const t of this.transitions) {
      if (t.on !== event.type) continue;
      if (t.from !== "*" && t.from !== state) continue;
      if (t.guard && !t.guard(event, state)) continue;
      return t;
    }
    return null;
  }

  can(event: E, currentState?: S): boolean {
    return this.match(event, currentState ?? this.state) !== null;
  }

  dispatch(event: E): { transitioned: boolean; from: S; to: S } {
    const from = this.state;
    const t = this.match(event, from);
    if (!t || t.to === from) {
      return { transitioned: false, from, to: from };
    }
    const to = t.to;
    const leave = this.leaveHooks.get(from);
    if (leave) for (const fn of leave) fn(to);
    this.state = to;
    if (t.effect) t.effect(event, { from, to });
    const enter = this.enterHooks.get(to);
    if (enter) for (const fn of enter) fn(from);
    this._history.push({ at: performance.now(), from, to, via: event.type });
    if (this._history.length > this.historyLimit) {
      this._history.splice(0, this._history.length - this.historyLimit);
    }
    return { transitioned: true, from, to };
  }

  history(): readonly FsmHistoryEntry<S, E["type"]>[] {
    return this._history;
  }
}
