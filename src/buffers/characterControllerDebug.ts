import { createBuffer, type Buffer } from "../runtime/buffer";
import type { EntityId } from "./entity";

/**
 * OPT-IN per-tick diagnostic capture for `CharacterControllerSystem`'s surface-frame
 * solver. Default is `enabled: false` — production runtime pays nothing beyond a single
 * bool check per surface-attached entity per tick. When a test enables it (via
 * `BufferTest.enableDebugBuffers`), the controller appends one `ControllerDebugRow` to
 * each surface-attached entity's `history` array each tick the entity is on the surface
 * branch.
 *
 * Lives in the production buffer set so the buffer-snapshot regression framework
 * (`src/app/bufferTest.ts`) can capture it and the comparator can flag any change in
 * intermediate values when scenarios run. This replaces the prior hacky `CONTROLLER_DEBUG`
 * module-level array + inline trace test pattern with a principled data-oriented capture
 * that goes through the same comparison logic as every other buffer.
 *
 * See [[worldgen-demo-debug-buffers-and-deprecated-rangedbaseline-2026-05-19]] and the
 * "MANDATORY change discipline" section in the project CLAUDE.md.
 */

/** One row per tick per entity. Mirrors the local intermediates inside the surface-frame
 *  solver. New fields can be added here as new diagnostic needs arise — the snapshot
 *  framework handles arbitrary numeric fields. */
export interface ControllerDebugRow {
  /** Tick index from the scheduler (= number of ticks since enabled, NOT wall-clock). */
  tick: number;
  /** Body velocity projected into the surface tangent frame. */
  vF: number;
  vR: number;
  vN: number;
  /** Slope (rad) between surface normal and the LOCAL gravity-up at the body's sample. */
  slopeRad: number;
  /** External (forceField) accel projected into the surface tangent frame. */
  aExN: number;
  aExF: number;
  aExR: number;
  /** Surface curvature-induced normal acceleration (m/s² along +N). */
  aCentripetalN: number;
  /** Friction grip cap on tangent thrust: μ × (|aExN| + selfNormalPush). */
  gripBudget: number;
  /** Detach-resist budget along -N (downAccel curve at current vN). */
  gripBudget_N: number;
  /** Per-direction biomechanical ceilings (pre-grip clamp). */
  fwdCeil: number;
  backCeil: number;
  rightCeil: number;
  leftCeil: number;
  /** Per-direction grip-clamped ceilings: min(ceil, gripBudget). */
  fwdMax: number;
  backMax: number;
  rightMax: number;
  leftMax: number;
  /** Required voluntary accel to reach desired velocity this tick. */
  aReqF: number;
  aReqR: number;
  /** Applied tangent accel after clamp. */
  aFEff: number;
  aREff: number;
  /** Pre-clamp and post-clamp surface reaction force along +N. */
  aSurfaceNRequired: number;
  aSurfaceN: number;
  /** Detach-rule terms. */
  apparentN: number;
  pullDemand: number;
  /** Body's self-applied normal-direction push (curves.downAccel evaluated at vN). */
  selfNormalPush: number;
  /** Magnitude of (vF, vR). */
  tangentSpeed: number;
}

export interface CharacterControllerDebugComponent {
  /** Appended each tick the entity is on the surface branch when `enabled = true`.
   *  Empty when the entity is airborne or capture is disabled. */
  history: ControllerDebugRow[];
}

export interface CharacterControllerDebugBufferData {
  /** Default false. Tests flip via `writeBuffer` before ticking. Production code leaves
   *  it false and the controller skips the capture write. */
  enabled: boolean;
  byEntity: Map<EntityId, CharacterControllerDebugComponent>;
}

export const CHARACTER_CONTROLLER_DEBUG_BUFFER_ID = "characterControllerDebug";

export function createCharacterControllerDebugBuffer(): Buffer<CharacterControllerDebugBufferData> {
  return createBuffer<CharacterControllerDebugBufferData>({
    id: CHARACTER_CONTROLLER_DEBUG_BUFFER_ID,
    description:
      "OPT-IN per-tick diagnostic capture for the surface-frame solver. Set `enabled = true` from a test (or via BufferTest.enableDebugBuffers) to append one ControllerDebugRow per entity per tick. Off by default in production. Goes through the regular buffer-snapshot comparator so changes in any intermediate value (gripBudget, aSurfaceN, aCentripetalN, applied tangent accel, etc.) surface as regression flags.",
    initial: { enabled: false, byEntity: new Map() },
  });
}
