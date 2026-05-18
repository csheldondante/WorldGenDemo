/**
 * Energy-conservation stress test. Spawns many characters on a heightmap with hills
 * (gradient in BOTH u and v directions, so tangents are non-orthogonal in much of the
 * patch). Each character random-walks its move input over time. The full Running-graph
 * subset runs against them in parallel.
 *
 * The invariant: a surface-attached body's total mechanical energy KE + GPE cannot
 * exceed `(1/2)·vMaxSustained² + g·peakHeight + initialEnergy`, with some headroom for
 * the controller's voluntary thrust pumping over a finite simulation window. Anything
 * dramatically over this bound indicates the integrator is creating energy — the class
 * of bug the user discovered manually (parallel-transport via non-orthogonal tangent
 * scalars injected free energy through the cross term, launching characters skyward
 * whenever they had lateral + gradient motion simultaneously).
 *
 * Per-entity trajectory logs are captured so any violator's history can be inspected.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer, readBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { registerCoreBuffers } from "../../src/buffers";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../../src/buffers/characterController";
import {
  CHARACTER_INPUT_BUFFER_ID,
  type CharacterInputBufferData,
  emptyInput,
} from "../../src/buffers/characterInput";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../../src/buffers/transform";
import { VELOCITY_BUFFER_ID, type VelocityBufferData } from "../../src/buffers/velocity";
import {
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../../src/buffers/surfaceAttachment";
import {
  SURFACE_PROVIDER_BUFFER_ID,
  type SurfaceProviderBufferData,
} from "../../src/buffers/surfaceProvider";
import { DEFAULT_PLAYER_PROFILE } from "../../src/buffers/characterControllerProfile";
import { createCharacterControllerSystem } from "../../src/systems/characterController";
import { createForceFieldSystem } from "../../src/systems/forceField";
import { createSurfaceConstrainedVelocitySystem } from "../../src/systems/surfaceConstrainedVelocity";
import { createVolumetricConstrainedVelocitySystem } from "../../src/systems/volumetricConstrainedVelocity";
import { createSurfaceConstraintSystem } from "../../src/systems/surfaceConstraint";
import { createTangentInputMapperSystem } from "../../src/systems/tangentInputMapper";
import { HeightmapSurfaceProvider } from "../../src/world/surfaceProvider";

const G = 9.81;
const NUM_AGENTS = 20;
const FRAMES = 600; // ~10 seconds at dt = 0.016
const DT = 0.016;

// Deterministic PRNG so test runs are reproducible.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Heightmap with rolling hills in BOTH directions — gradient is non-zero in both u and v
 *  across most of the patch, so tangentU·tangentV ≠ 0 (the exact regime that exposes the
 *  cross-term energy bug). Peak height ≈ 4m. */
function rollingHillsHeightmap(): HeightmapSurfaceProvider {
  const W = 80, D = 80, tileSize = 1;
  const data = new Float32Array(W * D);
  for (let z = 0; z < D; z++) {
    for (let x = 0; x < W; x++) {
      const u = (x / (W - 1)) * Math.PI * 4;
      const v = (z / (D - 1)) * Math.PI * 4;
      // Sum of sinusoids: peak amplitude 4m, hills in arbitrary diagonal orientations.
      const h =
        1.2 * Math.sin(u) * Math.cos(v) +
        0.8 * Math.sin(u * 0.7 + 1.3) * Math.cos(v * 0.9 + 0.4) +
        0.5 * Math.sin(u * 1.5 + 2.1) * Math.cos(v * 1.3 - 0.7) +
        1.5; // bias above 0
      data[z * W + x] = Math.max(0, h);
    }
  }
  return new HeightmapSurfaceProvider("rolling-hills", { width: W, height: D, tileSize, data });
}

interface AgentTrace {
  pos: [number, number, number];
  vel: [number, number, number];
  speed: number;
  ke: number;
  gpe: number;
  energy: number;
  state: string;
}

let consoleSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => { consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { consoleSpy?.mockRestore(); consoleSpy = null; });

describe("Multi-agent energy-conservation stress test", () => {
  it("random-walking agents on rolling hills do NOT accumulate free energy", () => {
    const provider = rollingHillsHeightmap();
    const peakHeight = 4.5; // empirical upper bound for the sinusoidal field

    const reg = createRegistry();
    registerCoreBuffers(reg);
    reg.registerSystem(createForceFieldSystem());
    reg.registerSystem(createTangentInputMapperSystem());
    reg.registerSystem(createCharacterControllerSystem());
    reg.registerSystem(createSurfaceConstrainedVelocitySystem());
    reg.registerSystem(createVolumetricConstrainedVelocitySystem());
    reg.registerSystem(createSurfaceConstraintSystem());

    const ccBuf = reg.getBuffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID);
    const ciBuf = reg.getBuffer<CharacterInputBufferData>(CHARACTER_INPUT_BUFFER_ID);
    const tBuf = reg.getBuffer<TransformBufferData>(TRANSFORM_BUFFER_ID);
    const vBuf = reg.getBuffer<VelocityBufferData>(VELOCITY_BUFFER_ID);
    const saBuf = reg.getBuffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID);
    const spBuf = reg.getBuffer<SurfaceProviderBufferData>(SURFACE_PROVIDER_BUFFER_ID);

    writeBuffer(spBuf, (d) => { d.heightmap = provider; });

    const rng = mulberry32(42);
    const radius = DEFAULT_PLAYER_PROFILE.bodyRadius;

    // Spawn NUM_AGENTS characters at random UV positions.
    const agentIds: number[] = [];
    writeBuffer(ccBuf, (cc) => {
      writeBuffer(ciBuf, (ci) => {
        writeBuffer(tBuf, (t) => {
          writeBuffer(vBuf, (v) => {
            writeBuffer(saBuf, (sa) => {
              for (let i = 0; i < NUM_AGENTS; i++) {
                const id = i + 1;
                agentIds.push(id);
                // Random UV in [0.1, 0.9] so they don't immediately walk off the edge.
                const u = 0.1 + rng() * 0.8;
                const vv = 0.1 + rng() * 0.8;
                const sample = provider.sampleAtUV(u, vv);
                cc.byEntity.set(id, {
                  state: "surfaceRun",
                  locomotionMode: "surfaceConstrained",
                  profileId: DEFAULT_PLAYER_PROFILE.id,
                  lastTransitionReason: "spawn",
      transitions: [],
                  timeInState: 0,
                  yawVel: 0,
                  targetYaw: 0,
                  bodyUpCurrent: [0, 0, 0, 1],
      bodyUpWorld: [0, 1, 0],
                  orientation: { current: [0, 0, 0, 1], target: [0, 0, 0, 1] },
      desiredFacingTangent: [0, 0, -1],
                });
                ci.byEntity.set(id, { ...emptyInput(0), cameraYaw: rng() * Math.PI * 2 });
                t.byEntity.set(id, {
                  position: [
                    sample.position[0] + sample.normal[0] * radius,
                    sample.position[1] + sample.normal[1] * radius,
                    sample.position[2] + sample.normal[2] * radius,
                  ],
                  yaw: 0,
                  scale: 1,
                });
                v.byEntity.set(id, { linear: [0, 0, 0], prevLinear: [0, 0, 0] });
                sa.byEntity.set(id, {
                  surfaceId: provider.id,
                  uv: [u, vv],
                  offsetAlongNormal: radius,
                  sample,
                });
              }
            });
          });
        });
      });
    });

    const g = buildExecutionGraph({
      id: "energy-stress",
      nodes: [
        "forceFieldSystem",
        "tangentInputMapperSystem",
        "characterControllerSystem",
        "surfaceConstrainedVelocitySystem",
        "volumetricConstrainedVelocitySystem",
        "surfaceConstraintSystem",
      ],
      registry: reg,
    });

    // Random-walk input state per agent. moveX, moveY, cameraYaw all drift.
    const inputState = agentIds.map(() => ({
      moveX: 0,
      moveY: 0,
      cameraYaw: rng() * Math.PI * 2,
    }));

    // Per-agent rolling trajectory (last K frames) for post-mortem inspection.
    const TRACE_WINDOW = 30;
    const traces: AgentTrace[][] = agentIds.map(() => []);

    // Energy bound — bounded above by initial energy plus the maximum work the
    // controller can do over the simulation window. Since the curve self-limits at
    // vMax, the controller's voluntary thrust produces zero net work in steady
    // state; only the transient acceleration from rest to vMax contributes.
    //   - Max steady-state KE per agent: (1/2)·vMax² + small headroom for downhill
    //     curve-shift = ~50. Allow 2× margin = 100.
    //   - Max GPE: g · peakHeight ≈ 44 (above 0); could go negative if falling.
    //   - INITIAL energy upper bound: initial GPE at spawn (highest agent might
    //     spawn at peak ≈ 4.5m + radius). Each agent's local bound = initial energy
    //     + KE bound. Compute the global bound as max-initial-GPE + KE bound.
    //
    // Pre-fix the cross-term injection grew energy by hundreds of joules over the
    // run. Post-fix energy stays close to "initial + the pumped fraction up to vMax².
    const vMax = DEFAULT_PLAYER_PROFILE.forwardAccel.vMax;
    const ENERGY_BOUND = 0.5 * Math.pow(vMax * 2, 2) + G * (peakHeight + radius + 1);
    // ≈ 0.5·256 + 53 = 181. Set with healthy margin; characteristic free-energy
    // bugs jump E by an order of magnitude.

    let maxEnergyEver = 0;
    let maxEnergyAgent = -1;
    let maxEnergyFrame = -1;

    for (let frame = 0; frame < FRAMES; frame++) {
      // Slowly random-walk each agent's input.
      writeBuffer(ciBuf, (ci) => {
        for (let i = 0; i < agentIds.length; i++) {
          const id = agentIds[i];
          const s = inputState[i];
          // Drift by Brownian noise with small step, clamped to [-1, 1].
          s.moveX = Math.max(-1, Math.min(1, s.moveX + (rng() - 0.5) * 0.15));
          s.moveY = Math.max(-1, Math.min(1, s.moveY + (rng() - 0.5) * 0.15));
          s.cameraYaw += (rng() - 0.5) * 0.05;
          ci.byEntity.set(id, {
            ...emptyInput(0),
            moveX: s.moveX,
            moveY: s.moveY,
            cameraYaw: s.cameraYaw,
          });
        }
      });

      executeGraph(g, reg, { dt: DT, now: frame * DT });

      // Snapshot per-agent state.
      const tNow = readBuffer(tBuf);
      const vNow = readBuffer(vBuf);
      const ccNow = readBuffer(ccBuf);
      for (let i = 0; i < agentIds.length; i++) {
        const id = agentIds[i];
        const tt = tNow.byEntity.get(id);
        const vv = vNow.byEntity.get(id);
        const cc = ccNow.byEntity.get(id);
        if (!tt || !vv || !cc) continue;
        const speed = Math.hypot(vv.linear[0], vv.linear[1], vv.linear[2]);
        const ke = 0.5 * speed * speed;
        // GPE: g·y, UN-clamped. Allows negative GPE for bodies that have fallen
        // off the surface. Total mechanical energy (KE + GPE) is conserved during
        // free fall (KE grows by exactly the GPE lost), so a body falling
        // indefinitely does NOT violate this invariant — only ACTIVE energy
        // injection from a buggy integrator does.
        const gpe = G * tt.position[1];
        const energy = ke + gpe;

        if (energy > maxEnergyEver) {
          maxEnergyEver = energy;
          maxEnergyAgent = i;
          maxEnergyFrame = frame;
        }

        // Push trace, keep last TRACE_WINDOW frames.
        traces[i].push({
          pos: [tt.position[0], tt.position[1], tt.position[2]],
          vel: [vv.linear[0], vv.linear[1], vv.linear[2]],
          speed,
          ke,
          gpe,
          energy,
          state: cc.state,
        });
        if (traces[i].length > TRACE_WINDOW) traces[i].shift();
      }
    }

    if (maxEnergyEver > ENERGY_BOUND) {
      // Dump the offender's recent trajectory so the violation can be diagnosed.
      const offender = traces[maxEnergyAgent];
      const lines = offender.map(
        (f, i) =>
          `  [${i}] pos=(${f.pos[0].toFixed(2)},${f.pos[1].toFixed(2)},${f.pos[2].toFixed(2)})` +
          ` vel=(${f.vel[0].toFixed(2)},${f.vel[1].toFixed(2)},${f.vel[2].toFixed(2)})` +
          ` speed=${f.speed.toFixed(2)} KE=${f.ke.toFixed(2)} GPE=${f.gpe.toFixed(2)} E=${f.energy.toFixed(2)} state=${f.state}`,
      );
      throw new Error(
        `Energy bound violated: agent ${maxEnergyAgent} at frame ${maxEnergyFrame} reached E=${maxEnergyEver.toFixed(2)} (bound ${ENERGY_BOUND.toFixed(2)}). ` +
          `Last ${TRACE_WINDOW} frames:\n${lines.join("\n")}`,
      );
    }

    // Healthy run sanity check: at least some agents should have moved meaningfully.
    const movedAgents = traces.filter((tr) => {
      const first = tr[0];
      const last = tr[tr.length - 1];
      if (!first || !last) return false;
      return Math.hypot(last.pos[0] - first.pos[0], last.pos[2] - first.pos[2]) > 0.5;
    });
    expect(movedAgents.length).toBeGreaterThan(0);
  });
});
