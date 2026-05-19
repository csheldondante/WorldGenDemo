import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_SYSTEM_ID } from "../runtime/stateMachine";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../buffers/velocity";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import { FORCE_ACCUMULATOR_BUFFER_ID, type ForceAccumulatorBufferData } from "../buffers/forceAccumulator";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import { SPHERE_BODY_BUFFER_ID, type SphereBodyBufferData } from "../buffers/sphereBody";
import { SURFACE_PROVIDER_BUFFER_ID, type SurfaceProviderBufferData } from "../buffers/surfaceProvider";
import { COLLISION_EVENTS_BUFFER_ID, type CollisionEventsBufferData } from "../buffers/collisionEvents";
import { sweepSphereVsHeightSurface, type HeightSurfaceQuery } from "../lib/spatial/arcSweep";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID } from "./surfaceConstrainedVelocity";

export const VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID = "volumetricConstrainedVelocitySystem";

/**
 * Fraction of the world-horizontal velocity component to bleed off on a
 * head-on CCD impact into a steep surface. Scales by the impact's head-on
 * fraction and the surface's verticality, so flat-ground contact loses 0%
 * and a perpendicular crash into a vertical wall loses up to this value.
 * Hardcoded for now; will likely become a per-surface or per-character
 * tunable later (e.g. ice vs. velcro walls, or heavy vs. agile archetypes).
 */
const IMPACT_HORIZONTAL_DAMPING = 0.75;

/**
 * Integration for airborne entities and any entity without a CharacterController.
 * Standard semi-implicit Euler in XYZ; no surface snap downstream. This is the path
 * for jumping, falling, projectiles, vehicles in airborne phase, etc.
 *
 * Iteration walks `VelocityBuffer.byEntity` (which is the universe of moving things)
 * rather than the character roster, then *excludes* entities flagged as
 * `surfaceConstrained` — those are integrated by `SurfaceConstrainedVelocitySystem`.
 * Non-character entities (no CC entry) fall through here by design.
 *
 * Runs after `SurfaceConstrainedVelocitySystem` to give a deterministic ordering on
 * the shared accumulator/velocity/transform buffers, even though the two systems
 * touch disjoint entity sets.
 */
export function createVolumetricConstrainedVelocitySystem(): SystemDescriptor {
  return {
    id: VOLUMETRIC_CONSTRAINED_VELOCITY_SYSTEM_ID,
    description:
      "Integrates airborne characters and non-character entities (any moving entity that is NOT locomotionMode === 'surfaceConstrained'). Semi-implicit Euler in XYZ. Runs after SurfaceConstrainedVelocitySystem to disambiguate shared-buffer ordering.",
    buffers: [
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: SPHERE_BODY_BUFFER_ID, access: "read" },
      { id: SURFACE_PROVIDER_BUFFER_ID, access: "read" },
      { id: FORCE_ACCUMULATOR_BUFFER_ID, access: "readwrite" },
      { id: VELOCITY_BUFFER_ID, access: "readwrite" },
      { id: TRANSFORM_BUFFER_ID, access: "readwrite" },
      { id: COLLISION_EVENTS_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID, CHARACTER_CONTROLLER_SYSTEM_ID, SURFACE_CONSTRAINED_VELOCITY_SYSTEM_ID],
    execute: ({ buffer, dt }) => {
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const spheres = readBuffer(buffer<SphereBodyBufferData>(SPHERE_BODY_BUFFER_ID));
      const provider = readBuffer(buffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID)).heightmap;
      const fa = buffer<ForceAccumulatorBufferData>(FORCE_ACCUMULATOR_BUFFER_ID);
      const vBuf = buffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
      const tBuf = buffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
      const evtBuf = buffer<CollisionEventsBufferData>(COLLISION_EVENTS_BUFFER_ID);
      const accels = readBuffer(fa);

      // Heightmap query for the arc-sweep CCD. Returns null if (x, z) is
      // outside the surface's UV region — body has flown off the map. For
      // curved-surface providers (cylinder/sphere/torus) we'd need a
      // different query strategy; those gyms don't currently exhibit
      // clipping, so leave them on the straight-line integrator for now.
      const heightQuery: HeightSurfaceQuery | null = provider
        ? (x, z) => {
            const [u, v] = provider.worldToUV(x, 0, z);
            if (u < 0 || u > 1 || v < 0 || v > 1) return null;
            const s = provider.sampleAtUV(u, v);
            return { height: s.position[1], normal: s.normal };
          }
        : null;

      writeBuffer(evtBuf, (e) => {
        // Clear events from previous tick. When CollisionDetectionSystem
        // exists alongside this one, the clear should move there (and
        // run before any producer); for now this is the sole producer.
        e.events.length = 0;
        writeBuffer(vBuf, (vels) => {
          writeBuffer(tBuf, (transforms) => {
            for (const [id, vel] of vels.byEntity) {
              const ctrl = cc.byEntity.get(id);
              if (ctrl && ctrl.locomotionMode === "surfaceConstrained") continue;
              vel.prevLinear[0] = vel.linear[0];
              vel.prevLinear[1] = vel.linear[1];
              vel.prevLinear[2] = vel.linear[2];
              const a = accels.byEntity.get(id);
              const ax = a ? a.accel[0] : 0;
              const ay = a ? a.accel[1] : 0;
              const az = a ? a.accel[2] : 0;
              const t = transforms.byEntity.get(id);
              if (!t) {
                vels.byEntity.set(id, vel);
                continue;
              }

              // Continuous collision against the heightmap surface. The body
              // follows p(τ) = p0 + v0·τ + ½·a·τ² for τ ∈ [0, dt]; without
              // CCD a single tick at high horizontal velocity can place the
              // body inside a steep terrain wall in one jump. The sweep finds
              // the first τ* where the body sphere touches the surface; we
              // clamp the integration to τ* and project velocity onto the
              // tangent plane so the body slides along the surface for the
              // remaining (dt − τ*).
              const sphere = spheres.byEntity.get(id);
              let stepDt = dt;
              if (sphere && heightQuery) {
                const hit = sweepSphereVsHeightSurface(
                  [t.position[0], t.position[1], t.position[2]],
                  [vel.linear[0], vel.linear[1], vel.linear[2]],
                  [ax, ay, az],
                  dt,
                  sphere.radius,
                  heightQuery,
                );
                if (hit) {
                  // Move to contact point and reduce remaining dt to (dt − hit.t).
                  t.position[0] = hit.point[0];
                  t.position[1] = hit.point[1];
                  t.position[2] = hit.point[2];
                  // Update velocity at the moment of contact (semi-implicit
                  // accumulation up to hit.t), then project off the surface
                  // normal so the body slides instead of clipping in.
                  vel.linear[0] += ax * hit.t;
                  vel.linear[1] += ay * hit.t;
                  vel.linear[2] += az * hit.t;
                  const vDotN =
                    vel.linear[0] * hit.normal[0] +
                    vel.linear[1] * hit.normal[1] +
                    vel.linear[2] * hit.normal[2];
                  if (vDotN < 0) {
                    // Head-on fraction = how much of the incoming speed was
                    // pointing into the surface. 1 = perpendicular crash,
                    // 0 = pure grazing. Computed before the tangent projection.
                    const preSpeed = Math.hypot(vel.linear[0], vel.linear[1], vel.linear[2]);
                    const intoFrac = preSpeed > 1e-6 ? Math.min(1, -vDotN / preSpeed) : 0;

                    // Tangent-project: remove the into-surface component.
                    vel.linear[0] -= vDotN * hit.normal[0];
                    vel.linear[1] -= vDotN * hit.normal[1];
                    vel.linear[2] -= vDotN * hit.normal[2];

                    // Damp the world-horizontal component of remaining tangent
                    // velocity when the impact is head-on into a steep surface.
                    // Without this, jumping into a steep slope tangent-projects
                    // cleanly and the body slides up the slope at full speed.
                    // World-vertical velocity is preserved so the vertical-to-
                    // forward ratio rises naturally as forward is bled off.
                    // gravity-up is derived from the per-entity accumulator
                    // (which is dominated by gravity from forceField at this
                    // point in the pipeline).
                    const gMag = Math.hypot(ax, ay, az) || 1;
                    const gUpX = -ax / gMag;
                    const gUpY = -ay / gMag;
                    const gUpZ = -az / gMag;
                    const NdotGUp = hit.normal[0] * gUpX + hit.normal[1] * gUpY + hit.normal[2] * gUpZ;
                    const verticality = Math.max(0, 1 - Math.max(0, NdotGUp)); // 0 flat, 1 vertical
                    const retain = Math.max(0, 1 - intoFrac * verticality * IMPACT_HORIZONTAL_DAMPING);
                    const vDotGUp = vel.linear[0] * gUpX + vel.linear[1] * gUpY + vel.linear[2] * gUpZ;
                    const vHX = vel.linear[0] - vDotGUp * gUpX;
                    const vHY = vel.linear[1] - vDotGUp * gUpY;
                    const vHZ = vel.linear[2] - vDotGUp * gUpZ;
                    vel.linear[0] = vHX * retain + vDotGUp * gUpX;
                    vel.linear[1] = vHY * retain + vDotGUp * gUpY;
                    vel.linear[2] = vHZ * retain + vDotGUp * gUpZ;
                  }
                  e.events.push({
                    a: id,
                    b: null,
                    normal: [hit.normal[0], hit.normal[1], hit.normal[2]],
                    depth: 0,
                    point: [hit.point[0], hit.point[1], hit.point[2]],
                  });
                  stepDt = dt - hit.t;
                }
              }

              // Standard semi-implicit Euler over the remaining (or full) dt.
              vel.linear[0] += ax * stepDt;
              vel.linear[1] += ay * stepDt;
              vel.linear[2] += az * stepDt;
              t.position[0] += vel.linear[0] * stepDt;
              t.position[1] += vel.linear[1] * stepDt;
              t.position[2] += vel.linear[2] * stepDt;
              transforms.byEntity.set(id, t);
              vels.byEntity.set(id, vel);
            }
          });
        });
      });

      // Clear accumulator for the entities we touched.
      writeBuffer(fa, (d) => {
        for (const [id, a] of d.byEntity) {
          const ctrl = cc.byEntity.get(id);
          if (ctrl && ctrl.locomotionMode === "surfaceConstrained") continue;
          a.accel[0] = 0; a.accel[1] = 0; a.accel[2] = 0;
        }
      });
    },
  };
}
