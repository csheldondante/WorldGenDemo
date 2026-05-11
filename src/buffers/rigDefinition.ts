import { createBuffer, type Buffer } from "../runtime/buffer";

/**
 * Skeletal-rig archetypes (bind pose + topology).
 *
 * Why a real buffer instead of a module constant: future archetypes (enemies,
 * NPCs, glide-form, etc.) plug in by writing to this buffer at registration or
 * load time. Consumers declare `read` of `rigDefinition` and don't need to
 * import a per-archetype TS module — keeps buffer access honest at the
 * registry level.
 */

export interface BoneTemplate {
  name: string;
  /** Index into bones[]; -1 for root. Invariant: parent < self. */
  parent: number;
  bindLocalPos: [number, number, number];
  bindLocalRot: [number, number, number, number];
}

/**
 * A spring-driven chain of bones (e.g. spine, tail, neck). ChainDynamicsSystem
 * iterates rig.chains generically — quadrupeds add a tail chain, snakes add
 * one long chain, no new system code required.
 *
 * `rootBone` is the chain's anchor (the "hip" for a spine, the rump for a
 * tail). It is *not* moved by the chain solver; it's the parent reference
 * frame the segments lean within. `segments` must be in parent-chain order
 * with the first segment parented to `rootBone`.
 */
export interface ChainSpec {
  name: string;
  rootBone: number;
  segments: number[];
  /** rad/s² per rad of offset from target. */
  stiffness: number;
  /** rad/s per rad/s of angular velocity. */
  damping: number;
  /**
   * Map horizontal velocity (m/s, pelvis-local frame) to total chain lean
   * angle (radians). At full run speed (8 m/s) and leanScale=0.04, total
   * lean ≈ 0.32 rad ≈ 18°, distributed evenly across segments.
   */
  leanScale: number;
  /** Maximum total lean angle (radians) before clamping. Protects against extreme accelerations. */
  maxLean: number;
}

export interface RigDefinition {
  id: string;
  bones: BoneTemplate[];
  /** Semantic name → bone index (e.g. "footL" → 6). */
  slots: Record<string, number>;
  /** Spring-driven chains (spine, tail, etc.) iterated by ChainDynamicsSystem. */
  chains: ChainSpec[];
}

export interface RigDefinitionBufferData {
  byId: Map<string, RigDefinition>;
}

export const RIG_DEFINITION_BUFFER_ID = "rigDefinition";

/**
 * Default biped — 10 bones, no arms. Arms get added when something needs them
 * (combat reach, glide spread, etc.).
 *
 * Bind-pose note: feet sit ~0.8 m below the pelvis, which sits at the entity's
 * transform position. The current spawn puts the sphere center ≈ bodyRadius
 * above the surface, so at bind pose the debug feet clip into the ground.
 * That's the visible cue that Phase 1C (foot IK against SurfaceProvider) is
 * the next thing to wire.
 */
const BIPED: RigDefinition = {
  id: "biped",
  bones: [
    { name: "pelvis",    parent: -1, bindLocalPos: [ 0,    0,    0], bindLocalRot: [0, 0, 0, 1] },
    { name: "spine1",    parent:  0, bindLocalPos: [ 0,    0.30, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "spine2",    parent:  1, bindLocalPos: [ 0,    0.30, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "head",      parent:  2, bindLocalPos: [ 0,    0.30, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "upperLegL", parent:  0, bindLocalPos: [ 0.10, 0,    0], bindLocalRot: [0, 0, 0, 1] },
    { name: "lowerLegL", parent:  4, bindLocalPos: [ 0,   -0.40, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "footL",     parent:  5, bindLocalPos: [ 0,   -0.40, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "upperLegR", parent:  0, bindLocalPos: [-0.10, 0,    0], bindLocalRot: [0, 0, 0, 1] },
    { name: "lowerLegR", parent:  7, bindLocalPos: [ 0,   -0.40, 0], bindLocalRot: [0, 0, 0, 1] },
    { name: "footR",     parent:  8, bindLocalPos: [ 0,   -0.40, 0], bindLocalRot: [0, 0, 0, 1] },
  ],
  slots: { pelvis: 0, head: 3, footL: 6, footR: 9 },
  chains: [
    // Spine chain — pelvis is the anchor (rootBone), spine1/spine2/head lean.
    // Critical damping: c = 2 * sqrt(k). k=80, c=18 → ~0.22s lean response.
    // leanScale 0.04 rad/(m/s) gives ~18° total lean at full 8 m/s run.
    {
      name: "spine",
      rootBone: 0,
      segments: [1, 2, 3],
      stiffness: 80,
      damping: 18,
      leanScale: 0.04,
      maxLean: 0.5,
    },
  ],
};

export function createRigDefinitionBuffer(): Buffer<RigDefinitionBufferData> {
  return createBuffer<RigDefinitionBufferData>({
    id: RIG_DEFINITION_BUFFER_ID,
    description:
      "Skeletal-rig archetypes (bind pose, parent topology, named bone slots). Pre-populated with 'biped'; future archetypes write additional entries. Read by SkeletonWorldSystem for topology and by spawn code for bind-pose initialization.",
    initial: { byId: new Map([["biped", BIPED]]) },
  });
}
