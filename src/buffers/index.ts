/**
 * Canonical buffer registration. The TS code is the source of truth; the
 * generated docs/REGISTRY.md mirrors it for human searching.
 */

import type { Registry } from "../runtime/registry";
import { createInputBuffer } from "./input";
import { createInputMapBuffer } from "./inputMap";
import { createCameraBuffer } from "./camera";
import { createEventBuffer } from "./event";
import { createStateMachineBuffer } from "./stateMachine";
import { createRenderRefsBuffer } from "./renderRefs";
import { createWorldDataBuffer } from "./worldData";
import { createTimingBuffer } from "./timing";
import { createBuilderBuffer } from "./builder";
import { createEntityBuffer } from "./entity";
import { createTransformBuffer } from "./transform";
import { createVelocityBuffer } from "./velocity";
import { createForceAccumulatorBuffer } from "./forceAccumulator";
import { createSphereBodyBuffer } from "./sphereBody";
import { createCharacterInputBuffer } from "./characterInput";
import { createCharacterTangentInputBuffer } from "./characterTangentInput";
import { createCharacterControllerBuffer } from "./characterController";
import { createCharacterControllerProfileBuffer } from "./characterControllerProfile";
import { createSurfaceAttachmentBuffer } from "./surfaceAttachment";
import { createSurfaceProviderBuffer } from "./surfaceProvider";
import { createVolumeFieldBuffer } from "./volumeField";
import { createRigDefinitionBuffer } from "./rigDefinition";
import { createSkeletonBuffer } from "./skeleton";
import { createFootLockBuffer } from "./footLock";
import { createColliderBuffer } from "./collider";
import { createCollisionEventsBuffer } from "./collisionEvents";

export function registerCoreBuffers(reg: Registry): void {
  // Runtime
  reg.registerBuffer(createInputBuffer());
  reg.registerBuffer(createInputMapBuffer());
  reg.registerBuffer(createCameraBuffer());
  reg.registerBuffer(createEventBuffer());
  reg.registerBuffer(createStateMachineBuffer());
  reg.registerBuffer(createRenderRefsBuffer());
  reg.registerBuffer(createWorldDataBuffer());
  reg.registerBuffer(createTimingBuffer());
  // Editor
  reg.registerBuffer(createBuilderBuffer());
  // V1 character + ECS
  reg.registerBuffer(createEntityBuffer());
  reg.registerBuffer(createTransformBuffer());
  reg.registerBuffer(createVelocityBuffer());
  reg.registerBuffer(createForceAccumulatorBuffer());
  reg.registerBuffer(createSphereBodyBuffer());
  reg.registerBuffer(createCharacterInputBuffer());
  reg.registerBuffer(createCharacterTangentInputBuffer());
  reg.registerBuffer(createCharacterControllerBuffer());
  reg.registerBuffer(createCharacterControllerProfileBuffer());
  reg.registerBuffer(createSurfaceAttachmentBuffer());
  reg.registerBuffer(createSurfaceProviderBuffer());
  reg.registerBuffer(createVolumeFieldBuffer());
  reg.registerBuffer(createRigDefinitionBuffer());
  reg.registerBuffer(createSkeletonBuffer());
  reg.registerBuffer(createFootLockBuffer());
  reg.registerBuffer(createColliderBuffer());
  reg.registerBuffer(createCollisionEventsBuffer());
}

export * from "./input";
export * from "./inputMap";
export * from "./camera";
export * from "./event";
export * from "./stateMachine";
export * from "./renderRefs";
export * from "./worldData";
export * from "./timing";
export * from "./builder";
export * from "./entity";
export * from "./transform";
export * from "./velocity";
export * from "./forceAccumulator";
export * from "./sphereBody";
export * from "./characterInput";
export * from "./characterTangentInput";
export * from "./characterController";
export * from "./characterControllerProfile";
export * from "./surfaceAttachment";
export * from "./surfaceProvider";
export * from "./volumeField";
export * from "./rigDefinition";
export * from "./skeleton";
export * from "./footLock";
export * from "./collider";
export * from "./collisionEvents";
