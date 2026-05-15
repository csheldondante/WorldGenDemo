import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
  type ControllerTransition,
} from "../buffers/characterController";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../buffers/inputMap";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { SURFACE_CONSTRAINT_SYSTEM_ID } from "./surfaceConstraint";
import { INPUT_MAPPER_SYSTEM_ID } from "./inputMapper";
import { BODY_LEAN_SYSTEM_ID } from "./bodyLean";
import { CHARACTER_ORIENTATION_SYSTEM_ID } from "./characterOrientation";
import { PLAYER_SPAWN_SYSTEM_ID } from "./pipeline/playerSpawn";
import { MINIMAP_SYSTEM_ID } from "./minimap";

export const HUD_SYSTEM_ID = "hudSystem";

/** Max simultaneously-visible messages (oldest scrolls off top when this is exceeded). */
const MAX_MESSAGES = 3;
/**
 * How long a message stays on screen after it was recorded — in MILLISECONDS,
 * because the scheduler's `now` is `performance.now()` (ms), not seconds.
 * `dt` is seconds; `now` is ms. Don't confuse the two.
 */
const MESSAGE_LIFETIME_MS = 2500;

/**
 * Format the visible transition stack, oldest → newest top-to-bottom. The
 * `#hud` element is anchored bottom-left in CSS, so as the stack grows the
 * box expands upward — newest entry is always on the bottom line.
 */
export function formatHud(args: {
  transitions: ControllerTransition[];
  /** Scheduler `now` in milliseconds (`performance.now()`). */
  now: number;
  /** Message lifetime in the same unit as `now` (milliseconds). */
  lifetimeMs: number;
  maxMessages: number;
}): string {
  const cutoff = args.now - args.lifetimeMs;
  const recent = args.transitions.filter((tr) => tr.t >= cutoff);
  const tail = recent.slice(-args.maxMessages);
  return tail.map((tr) => `${tr.from} → ${tr.to}: ${tr.reason}`).join("\n");
}

export function createHudSystem(): SystemDescriptor {
  // UI-cursor closure state (same precedent as SceneCyclerSystem): purely display-side,
  // never read by gameplay. H key toggles visibility entirely.
  let visible = true;
  // DOM diff cache: only write textContent when the rendered string actually changes.
  // The render loop runs every tick (~60Hz); without this the panel flickers visibly
  // as the browser re-lays out for each identical textContent assignment.
  let lastText: string | null = null;
  let lastDisplay: string | null = null;
  return {
    id: HUD_SYSTEM_ID,
    description:
      "Renders a rolling transition-log toast (max 3 messages, ~2.5s lifetime each) for the player character. H toggles visibility. DOM-diffs to prevent flicker; otherwise silent when no recent transitions.",
    buffers: [
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
    ],
    runsAfter: [
      STATE_MACHINE_SYSTEM_ID,
      // All systems that write CharacterControllerBuffer must run before us so the
      // transitions list and player state read consistently this tick. Out-of-graph
      // IDs are silently dropped, so one list works across Loading/Running/Rebuilding/Builder.
      CHARACTER_CONTROLLER_SYSTEM_ID,
      SURFACE_CONSTRAINT_SYSTEM_ID,
      BODY_LEAN_SYSTEM_ID,
      CHARACTER_ORIENTATION_SYSTEM_ID,
      PLAYER_SPAWN_SYSTEM_ID,
      INPUT_MAPPER_SYSTEM_ID,
      MINIMAP_SYSTEM_ID,
    ],
    execute: ({ buffer, now }) => {
      const refs = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      if (!refs.hudEl) return;
      if (im.actions.toggleHud.pressed) visible = !visible;
      const first = cc.byEntity.values().next();
      const transitions = first.done ? [] : first.value.transitions;
      const text = visible
        ? formatHud({
            transitions,
            now,
            lifetimeMs: MESSAGE_LIFETIME_MS,
            maxMessages: MAX_MESSAGES,
          })
        : "";
      // Collapse the panel (hide the element entirely) when there's nothing to show.
      // The CSS gives #hud a dark background + padding, so an empty textContent
      // would still leave a visible sliver; full `display:none` matches the
      // user's "collapse it down" intent.
      const nextDisplay = text.length > 0 ? "" : "none";
      if (nextDisplay !== lastDisplay) {
        refs.hudEl.style.display = nextDisplay;
        lastDisplay = nextDisplay;
      }
      if (text !== lastText) {
        refs.hudEl.textContent = text;
        lastText = text;
      }
    },
  };
}
