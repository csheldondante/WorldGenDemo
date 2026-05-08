/**
 * Canonical buffer registration. The TS code is the source of truth; the
 * generated docs/REGISTRY.md mirrors it for human searching.
 */

import type { Registry } from "../runtime/registry";
import { createInputBuffer } from "./input";
import { createCameraBuffer } from "./camera";
import { createEventBuffer } from "./event";
import { createStateMachineBuffer } from "./stateMachine";
import { createRenderRefsBuffer } from "./renderRefs";
import { createWorldDataBuffer } from "./worldData";
import { createTimingBuffer } from "./timing";
import { createBuilderBuffer } from "./builder";

export function registerCoreBuffers(reg: Registry): void {
  reg.registerBuffer(createInputBuffer());
  reg.registerBuffer(createCameraBuffer());
  reg.registerBuffer(createEventBuffer());
  reg.registerBuffer(createStateMachineBuffer());
  reg.registerBuffer(createRenderRefsBuffer());
  reg.registerBuffer(createWorldDataBuffer());
  reg.registerBuffer(createTimingBuffer());
  reg.registerBuffer(createBuilderBuffer());
}

export * from "./input";
export * from "./camera";
export * from "./event";
export * from "./stateMachine";
export * from "./renderRefs";
export * from "./worldData";
export * from "./timing";
export * from "./builder";
