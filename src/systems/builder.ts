import type { SystemDescriptor } from "../runtime/system";
import { readBuffer } from "../runtime/buffer";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { BUILDER_BUFFER_ID } from "../buffers/builder";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../buffers/stateMachine";
import { EVENT_BUFFER_ID } from "../buffers/event";
import { WORLD_DATA_BUFFER_ID } from "../buffers/worldData";
import { TIMING_BUFFER_ID } from "../buffers/timing";
import { BUILDER_INPUT_SYSTEM_ID, type BuilderInputAccumulator } from "./builderInput";

export const BUILDER_SYSTEM_ID = "builderSystem";

/**
 * Drains BuilderEvent[] from the accumulator and applies them to BuilderBuffer.
 *
 * Active only when the SM is in `Builder` state. On the first tick of a Builder
 * activation, bootstraps the buffer (loads active scene's bitmap into pixels;
 * builds the palette from scene labels ∪ defaults). On subsequent ticks, drains
 * the event queue.
 *
 * Phase 1: skeleton — the system exists, the graph validates, the gating works.
 * Phase 3 fills in the event handlers.
 */
export function createBuilderSystem(_acc: BuilderInputAccumulator): SystemDescriptor {
  return {
    id: BUILDER_SYSTEM_ID,
    description:
      "Mutates BuilderBuffer in response to BuilderEvent[] from the DOM. Only runs in Builder state. On first activation, loads the active scene bitmap and seeds the palette.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: BUILDER_BUFFER_ID, access: "readwrite" },
      { id: WORLD_DATA_BUFFER_ID, access: "read" },
      // SendToWorld will push RebuildRequested
      { id: EVENT_BUFFER_ID, access: "readwrite" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, BUILDER_INPUT_SYSTEM_ID],
    execute: ({ buffer }) => {
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      if (sm.state !== "Builder") return;
      // Phase 3: drain accumulator, apply to BuilderBuffer.
      // Phase 3: bootstrap from WorldDataBuffer on first activation.
    },
  };
}
