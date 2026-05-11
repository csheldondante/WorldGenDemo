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
 * `rootBone` is metadata: the bone the chain conceptually attaches to (the
 * "hip" for a spine, the rump for a tail). Whether `rootBone` itself leans
 * depends on whether it appears in `segments`. For the biped spine we want
 * the whole rig to tilt, so the pelvis is included in `segments` — the user
 * runs forward and gravity-vs-foot-thrust pitches the whole body forward,
 * not just the upper torso.
 *
 * Lean target combines two terms (Wolfire-style + light pendulum physics):
 *
 *   target_lean = leanScaleVel * horizontalVelocity   (steady-state running posture)
 *               + leanScaleAccel * horizontalAccel    (transient response, ≈ a/g pendulum tilt)
 *
 * Critical damping `damping = 2*sqrt(stiffness)` gives a smooth response with
 * no oscillation. Spring lag automatically produces nice secondary motion on
 * direction changes.
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
   * Steady-state lean per unit of horizontal velocity (rad / (m/s)). At full
   * run (8 m/s) and leanScaleVel=0.03, total lean ≈ 0.24 rad ≈ 14°.
   */
  leanScaleVel: number;
  /**
   * Transient lean per unit of horizontal acceleration (rad / (m/s²)).
   * Mirrors the inverted-pendulum equilibrium `tan(θ) ≈ a/g`. With g≈10 the
   * physical value is ~0.1; we use a slightly damped 0.05 to avoid overshoot
   * during normal accel spikes.
   */
  leanScaleAccel: number;
  /** Maximum total lean angle (radians) before clamping. Protects against extreme inputs. */
  maxLean: number;
}

/**
 * A 2-bone IK chain (leg, arm). FootIKSystem iterates these generically; a
 * quadruped declares four legs, a snake zero. Bone lengths are derived from
 * `bindLocalPos` of `kneeBone` and `footBone` so the rig stays the single
 * source of truth for geometry.
 */
export interface LegSpec {
  name: string;
  /** Upper bone (hip). */
  hipBone: number;
  /** Lower bone (knee). */
  kneeBone: number;
  /** End-effector (foot). */
  footBone: number;
  /**
   * Direction the mid joint should bend toward, in the upper bone's parent
   * frame. For a biped knee bending forward this is pelvis-local forward,
   * i.e. `[0, 0, -1]`. Quadruped back legs flip the sign.
   */
  kneePoleDir: [number, number, number];
}

export interface RigDefinition {
  id: string;
  bones: BoneTemplate[];
  /** Semantic name → bone index (e.g. "footL" → 6). */
  slots: Record<string, number>;
  /** Spring-driven chains (spine, tail, etc.) iterated by ChainDynamicsSystem. */
  chains: ChainSpec[];
  /** Two-bone IK chains (legs, arms) iterated by FootIKSystem / future ArmIKSystem. */
  legs: LegSpec[];
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
    // Pelvis sits ~0.3 m above the entity transform so the feet's bind-pose
    // Y lands at ground level (entity Y = bodyRadius = 0.5; pelvis Y = 0.8;
    // foot Y = 0.8 − 0.8 = 0). Without this offset the bind pose would put
    // feet 0.3 m underground and the IK clamp would force the knees into a
    // permanent bent-at-idle pose.
    { name: "pelvis",    parent: -1, bindLocalPos: [ 0,    0.3,  0], bindLocalRot: [0, 0, 0, 1] },
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
  slots: {
    pelvis: 0,
    head: 3,
    // Per-leg bone slots so FootIKSystem can address each chain generically.
    // A quadruped will add foreUpperLegL/foreLowerLegL/foreFootL etc.; the IK
    // system iterates rig.legChains (declared below) so naming here is purely
    // documentation.
    upperLegL: 4, lowerLegL: 5, footL: 6,
    upperLegR: 7, lowerLegR: 8, footR: 9,
  },
  chains: [
    // Spine chain — the whole rig tilts forward when running. Pelvis (bone 0)
    // is in `segments` so its localRot leans relative to the entity transform;
    // chain composition makes the head's cumulative world tilt = segment-count
    // × per-segment lean. Hence "whole rig leans, top leans furthest."
    //
    // Tuning (subject to feel-testing in the browser):
    //   stiffness=80, damping=18 ≈ 2√k → critically damped, ~0.22s response.
    //   leanScaleVel=0.03 → 14° steady-state lean at full 8 m/s run.
    //   leanScaleAccel=0.05 → +14° lean at 5 m/s² accel (≈ inverted-pendulum).
    //   maxLean=0.6 rad ≈ 34° hard cap.
    {
      name: "spine",
      rootBone: 0,
      segments: [0, 1, 2, 3],
      stiffness: 80,
      damping: 18,
      leanScaleVel: 0.03,
      leanScaleAccel: 0.05,
      maxLean: 0.6,
    },
  ],
  legs: [
    // Knee bends forward in pelvis-local frame. Forward is -Z under three.js
    // conventions used by the rest of the project.
    { name: "legL", hipBone: 4, kneeBone: 5, footBone: 6, kneePoleDir: [0, 0, -1] },
    { name: "legR", hipBone: 7, kneeBone: 8, footBone: 9, kneePoleDir: [0, 0, -1] },
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
