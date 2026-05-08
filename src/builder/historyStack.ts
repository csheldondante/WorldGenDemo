import type { HistoryFrame } from "../buffers/builder";
import { HISTORY_LIMIT } from "../buffers/builder";

/**
 * Pure undo/redo stack for bitmap snapshots. State = `{ history, index }`,
 * where `index` points at the *current* state. Undo decrements; redo
 * increments. Pushing a new frame after an undo discards the redo tail.
 */

export interface HistoryState {
  history: HistoryFrame[];
  /** Index of the current snapshot. -1 means empty. */
  index: number;
}

export function emptyHistory(): HistoryState {
  return { history: [], index: -1 };
}

/** Push a snapshot. Truncates the redo tail. Caps at HISTORY_LIMIT. */
export function pushHistory(state: HistoryState, frame: HistoryFrame): HistoryState {
  // Drop everything after the current index (the redo tail).
  const truncated = state.history.slice(0, state.index + 1);
  truncated.push(frame);
  // Cap from the *front* so the most recent HISTORY_LIMIT frames remain.
  const dropped = Math.max(0, truncated.length - HISTORY_LIMIT);
  const finalHistory = truncated.slice(dropped);
  return { history: finalHistory, index: finalHistory.length - 1 };
}

/** Move the cursor back one step. Returns the same state if already at the start. */
export function undo(state: HistoryState): HistoryState {
  if (state.index <= 0) return state;
  return { history: state.history, index: state.index - 1 };
}

/** Move the cursor forward one step. Returns the same state if already at the end. */
export function redo(state: HistoryState): HistoryState {
  if (state.index < 0) return state;
  if (state.index >= state.history.length - 1) return state;
  return { history: state.history, index: state.index + 1 };
}

export function currentFrame(state: HistoryState): HistoryFrame | null {
  if (state.index < 0 || state.index >= state.history.length) return null;
  return state.history[state.index];
}

export function canUndo(state: HistoryState): boolean {
  return state.index > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.index >= 0 && state.index < state.history.length - 1;
}
