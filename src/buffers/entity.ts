import { createBuffer, type Buffer } from "../runtime/buffer";

/**
 * Entity ID is just an integer. Component buffers are keyed by it.
 * Sparse — alive set tracks which IDs are valid.
 */
export type EntityId = number;

export interface EntityBufferData {
  nextId: EntityId;
  alive: Set<EntityId>;
}

export const ENTITY_BUFFER_ID = "entity";

export function createEntityBuffer(): Buffer<EntityBufferData> {
  return createBuffer<EntityBufferData>({
    id: ENTITY_BUFFER_ID,
    description:
      "Lightweight ECS: entities are integer IDs in `alive`; components live in keyed buffers (transform, velocity, characterController, etc).",
    initial: { nextId: 1, alive: new Set() },
  });
}

/** Mutating helper: allocate a new entity id, mark it alive. */
export function spawnEntity(data: EntityBufferData): EntityId {
  const id = data.nextId;
  data.nextId += 1;
  data.alive.add(id);
  return id;
}

/** Mutating helper: mark an entity dead. Component buffers are responsible
 *  for clearing their own keys when they read alive=false next tick. */
export function despawnEntity(data: EntityBufferData, id: EntityId): void {
  data.alive.delete(id);
}
