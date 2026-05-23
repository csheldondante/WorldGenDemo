import { createBuffer, type Buffer } from "../runtime/buffer";
import {
  STATE_MACHINE_BUFFER_ID,
  type StateMachineBufferData,
} from "../runtime/stateMachine";

export type { StateMachineBufferData };
export { STATE_MACHINE_BUFFER_ID };

export function createStateMachineBuffer(): Buffer<StateMachineBufferData> {
  return createBuffer<StateMachineBufferData>({
    id: STATE_MACHINE_BUFFER_ID,
    description: "Active runtime state + the graph id the scheduler should run this tick.",
    initial: { state: "Startup", activeGraph: "Loading", activeMode: "Loading", pendingEvents: [], pendingLoad: null, pendingRebuild: null, rebuildGeneration: 0 },
  });
}
