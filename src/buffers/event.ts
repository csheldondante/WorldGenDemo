import { createBuffer, type Buffer } from "../runtime/buffer";
import {
  EVENT_BUFFER_ID,
  type RuntimeEvent,
} from "../runtime/stateMachine";

export type { RuntimeEvent };
export { EVENT_BUFFER_ID };

export function createEventBuffer(): Buffer<RuntimeEvent[]> {
  return createBuffer<RuntimeEvent[]>({
    id: EVENT_BUFFER_ID,
    description: "FIFO event queue drained each tick by StateMachineSystem.",
    initial: [],
  });
}
