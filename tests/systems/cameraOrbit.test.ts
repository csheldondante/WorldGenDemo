import { describe, it, expect } from "vitest";
import { createRegistry } from "../../src/runtime/registry";
import { readBuffer, writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import {
  createCameraBuffer,
  CAMERA_BUFFER_ID,
  type CameraBufferData,
} from "../../src/buffers/camera";
import {
  createInputMapBuffer,
  INPUT_MAP_BUFFER_ID,
  type InputMapBufferData,
} from "../../src/buffers/inputMap";
import {
  createCameraOrbitSystem,
  CAMERA_ORBIT_SYSTEM_ID,
} from "../../src/systems/cameraOrbit";

function setup() {
  const reg = createRegistry();
  reg.registerBuffer(createCameraBuffer());
  reg.registerBuffer(createInputMapBuffer());
  reg.registerSystem(createCameraOrbitSystem());
  const graph = buildExecutionGraph({
    id: "test",
    nodes: [CAMERA_ORBIT_SYSTEM_ID],
    registry: reg,
  });
  return { reg, graph };
}

/**
 * Align `state.followedBodyYaw` with `target.yaw` — the steady-state where
 * the camera is already behind the player and auto-yaw has zero delta to
 * chase. This is the principled way to make geometry tests independent of
 * auto-yaw: not by disabling the feature, but by setting up the state where
 * it correctly does nothing. If a geometry change broke this assumption
 * (e.g. auto-yaw started chasing even at zero delta), the test would still
 * flag it.
 */
function alignBodyYaw(reg: ReturnType<typeof setup>["reg"]) {
  writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
    d.state.followedBodyYaw = d.target.yaw;
  });
}

function tick(reg: ReturnType<typeof setup>["reg"], graph: ReturnType<typeof setup>["graph"]) {
  executeGraph(graph, reg, { now: 0, dt: 1 / 60 });
}

function setPivot(reg: ReturnType<typeof setup>["reg"], position: [number, number, number]) {
  writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
    d.pivot.position = position;
  });
}

function setLook(reg: ReturnType<typeof setup>["reg"], yaw: number, pitch: number) {
  writeBuffer(reg.getBuffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID), (d) => {
    d.lookDelta = { yaw, pitch };
  });
}

describe("cameraOrbitSystem (Phase 2 spherical orbit around pivot.up)", () => {
  it("accumulates lookDelta.yaw into target.yaw; FLIPS lookDelta.pitch sign so mouse-down (negative lookDelta.pitch) lifts the camera", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.pitch = 0;
      // Disable cushion + hard floor so we test the raw accumulator without
      // restoring forces dragging target.pitch back upward.
      d.params.pitchSoftMin = -10;
      d.params.pitchMin = -10;
    });
    setLook(reg, 0.1, -0.05);  // mouseDx>0 → yaw=0.1; mouseDy>0 → lookDelta.pitch=-0.05
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.yaw).toBeCloseTo(0.1, 12);
    // target.pitch = 0 - (-0.05) = +0.05 → camera lifted ABOVE pivot
    expect(cam.target.pitch).toBeCloseTo(0.05, 12);
  });

  it("hard-clamps target.pitch to params.pitchMin / pitchMax (Phase 2 — no cushion yet)", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    // Huge negative lookDelta.pitch → mouse pushed UP → target.pitch decreases.
    setLook(reg, 0, 999);
    tick(reg, graph);
    let cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.pitch).toBeCloseTo(cam.params.pitchMin, 12);
    // Huge positive lookDelta.pitch → mouse pushed DOWN → target.pitch rises.
    setLook(reg, 0, -999);
    tick(reg, graph);
    cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.pitch).toBeCloseTo(cam.params.pitchMax, 12);
  });

  it("at flat gravity (up=+Y, fwd=-Z), yaw=0 pitch=atan(2.6/6), distance=√(6²+2.6²): camera matches the legacy (0, 2.6, 6) offset", () => {
    const { reg, graph } = setup();
    setPivot(reg, [10, 0, 20]);
    // Buffer defaults already set target.pitch = atan(2.6/6), distance = √(6²+2.6²).
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pos[0]).toBeCloseTo(10, 9);
    expect(cam.pos[1]).toBeCloseTo(2.6, 9);
    expect(cam.pos[2]).toBeCloseTo(26, 9);
  });

  it("at flat gravity with yaw=π/2: camera rotates 90° around pivot.up to +X side (matches legacy YXZ Euler convention)", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.yaw = Math.PI / 2;
      d.target.pitch = 0;       // horizon-level — needs floor + cushion relaxed
      d.params.distance = 6;
      d.params.pitchMin = -1;
      d.params.pitchSoftMin = -1;
      // Pre-seed cam.pos near the orbit target to skip the spawn snap.
      d.pos = [6, 0, 0];
    });
    // Align followedBodyYaw with target.yaw so auto-yaw has zero delta to
    // chase. This is the "camera already behind player" steady state — auto-yaw
    // is enabled but silent, which is what we want for a pure orbit geometry test.
    alignBodyYaw(reg);
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.pos[0]).toBeCloseTo(6, 9);
    expect(cam.pos[1]).toBeCloseTo(0, 9);
    expect(cam.pos[2]).toBeCloseTo(0, 9);
  });

  it("on a side-pivoted up (e.g. cylinder side: up=+X), camera elevates in the +X direction with positive pitch", () => {
    const { reg, graph } = setup();
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.pivot.position = [0, 0, 0];
      d.pivot.up = [1, 0, 0];
      d.pivot.fwd = [0, 0, -1];   // ⊥ up, parallel-transported
      d.target.yaw = 0;
      d.target.pitch = Math.PI / 4;  // 45° elevation
      d.params.distance = 6;
    });
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // pos = pivot + (-yawedFwd·cos(p) + up·sin(p))·D
    // yawedFwd = fwd at yaw=0 = (0,0,-1); -yawedFwd = (0,0,1)
    // up·sin(45°) = (sin45, 0, 0); cos(45°) = √2/2
    // pos = 0 + ((0,0,√2/2) + (√2/2, 0, 0))·6 = (3√2, 0, 3√2) ≈ (4.243, 0, 4.243)
    const expected = 6 * Math.SQRT2 / 2;
    expect(cam.pos[0]).toBeCloseTo(expected, 9);
    expect(cam.pos[1]).toBeCloseTo(0, 9);
    expect(cam.pos[2]).toBeCloseTo(expected, 9);
  });

  it("Phase 3 cushion: target.pitch below pitchSoftMin gets a restoring push back toward softMin", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.pitch = 0.10;  // below softMin=0.18, above hardMin=0.05
      d.params.pitchSoftMin = 0.18;
      d.params.pitchMin = 0.05;
      d.params.pitchCushionStiffness = 40;
    });
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // cushion adds (softMin - target.pitch) * (1 - exp(-dt * stiffness))
    //            = (0.18 - 0.10) * (1 - exp(-1/60 * 40))
    //            ≈ 0.08 * 0.4866 ≈ 0.0389
    // → final target.pitch ≈ 0.10 + 0.039 ≈ 0.139
    expect(cam.target.pitch).toBeGreaterThan(0.10);
    expect(cam.target.pitch).toBeLessThan(0.18);
    expect(cam.target.pitch).toBeCloseTo(0.10 + 0.08 * (1 - Math.exp(-1/60 * 40)), 6);
  });

  it("Phase 3 hard floor: target.pitch is hard-clamped to pitchMin no matter how hard the user pushes", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.pitch = 0.18;
    });
    // Push pitch HARD past the soft cushion. lookDelta.pitch = +50 → target -= 50.
    setLook(reg, 0, 50);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // The cushion can't catch up over a single huge shove, so the hard
    // clamp is what enforces the floor.
    expect(cam.target.pitch).toBeCloseTo(cam.params.pitchMin, 12);
    expect(cam.target.pitch).toBeGreaterThanOrEqual(cam.params.pitchMin);
  });

  it("Phase 3 spawn snap: if cam.pos is far from desired (>3·distance), snap rather than glide", () => {
    const { reg, graph } = setup();
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.pos = [0, 8, 60];           // buffer default — far from pivot
      d.pivot.position = [0, 0, 0];
      d.target.yaw = 0;
      d.target.pitch = Math.atan2(2.6, 6);
      d.params.distance = Math.hypot(6, 2.6);
    });
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // Should snap immediately (orbitAlpha = 1 because dist > 3·D).
    // desired pos: pivot + (0, 2.6, 6) = (0, 2.6, 6).
    expect(cam.pos[0]).toBeCloseTo(0, 6);
    expect(cam.pos[1]).toBeCloseTo(2.6, 6);
    expect(cam.pos[2]).toBeCloseTo(6, 6);
  });

  it("unwraps worldYaw across the atan2 branch cut: a tiny rotation past π stays a tiny delta, not a 2π jump", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    // Seed cam.yaw just BELOW π (say π − 0.01). Then drive a small mouse-yaw
    // that would push the target past π. The atan2-derived raw yaw flips to
    // roughly −π + small_delta; the unwrap should pull it back to ~π + small_delta.
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.yaw = Math.PI - 0.01;
      d.target.yaw = Math.PI - 0.01;
      d.target.pitch = 0.4;     // any non-pole pitch
      d.pos = [0, 0, 0];        // force snap on first tick
    });
    setLook(reg, 0.02, 0);  // small positive yaw delta — straddles +π
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // Expect cam.yaw to stay near +π, NOT flip to −π
    expect(cam.yaw).toBeGreaterThan(Math.PI - 0.5);
    expect(cam.yaw).toBeLessThan(Math.PI + 0.5);
  });

  it("derives renderer-facing yaw/pitch (YXZ Euler around world axes) from the world-space view direction", () => {
    const { reg, graph } = setup();
    setPivot(reg, [0, 0, 0]);
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.yaw = 0;
      d.target.pitch = Math.atan2(2.6, 6);  // back to default
      d.params.distance = Math.hypot(6, 2.6);
    });
    setLook(reg, 0, 0);
    tick(reg, graph);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // Camera at (0, 2.6, 6) looking at origin → view direction (0, -2.6, -6)/dist.
    // YXZ Euler: world_pitch = asin(view.y) = asin(-2.6/dist) ≈ -0.409.
    // world_yaw = atan2(-view.x, -view.z) = atan2(0, 6/dist) = 0.
    expect(cam.pitch).toBeCloseTo(-Math.atan2(2.6, 6), 9);
    expect(cam.yaw).toBeCloseTo(0, 9);
  });
});

describe("cameraOrbitSystem auto-yaw (camera follows player facing when hands-off)", () => {
  function autoSetup() {
    const reg = createRegistry();
    reg.registerBuffer(createCameraBuffer());
    reg.registerBuffer(createInputMapBuffer());
    reg.registerSystem(createCameraOrbitSystem());
    const graph = buildExecutionGraph({
      id: "test",
      nodes: [CAMERA_ORBIT_SYSTEM_ID],
      registry: reg,
    });
    // followBodyYaw stays at its default (true) for these tests.
    return { reg, graph };
  }
  function tickN(
    reg: ReturnType<typeof autoSetup>["reg"],
    graph: ReturnType<typeof autoSetup>["graph"],
    n: number,
  ) {
    for (let i = 0; i < n; i++) executeGraph(graph, reg, { now: 0, dt: 1 / 60 });
  }

  it("does NOT chase when |body yaw − target yaw| is inside the dead-zone (no oscillation on tiny corrections)", () => {
    const { reg, graph } = autoSetup();
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.yaw = 0;
      d.state.followedBodyYaw = 0.3;   // 0.3 rad < default dead-zone 0.5
      d.state.timeSinceLookInputSec = 999;  // long idle
      d.pos = [-6.54, 2.6, 0];          // pre-seeded to skip spawn snap
      d.pivot.position = [0, 0, 0];
      d.target.pitch = Math.atan2(2.6, 6);
      d.params.distance = Math.hypot(6, 2.6);
    });
    setLook(reg, 0, 0);
    tickN(reg, graph, 30);  // half a second
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.yaw).toBeCloseTo(0, 6);  // no movement inside dead-zone
  });

  it("DOES chase when outside the dead-zone (camera reacquires behind the player)", () => {
    const { reg, graph } = autoSetup();
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.yaw = 0;
      d.state.followedBodyYaw = 1.5;     // way outside dead-zone (0.5)
      d.state.timeSinceLookInputSec = 999;
      d.pos = [-6.54, 2.6, 0];
      d.pivot.position = [0, 0, 0];
      d.target.pitch = Math.atan2(2.6, 6);
      d.params.distance = Math.hypot(6, 2.6);
    });
    setLook(reg, 0, 0);
    tickN(reg, graph, 120);  // 2 seconds — gentle chase should converge
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.yaw).toBeGreaterThan(0.5);
    expect(cam.target.yaw).toBeLessThan(1.6);
  });

  it("does NOT chase while the user is actively looking (recent input gate)", () => {
    const { reg, graph } = autoSetup();
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.target.yaw = 0;
      d.state.followedBodyYaw = 1.5;     // outside dead-zone
      d.state.timeSinceLookInputSec = 0;
      d.pos = [-6.54, 2.6, 0];
      d.pivot.position = [0, 0, 0];
      d.target.pitch = Math.atan2(2.6, 6);
      d.params.distance = Math.hypot(6, 2.6);
    });
    // Drive a constant tiny look-yaw each tick — keeps timeSinceLookInputSec at 0.
    for (let i = 0; i < 60; i++) {
      setLook(reg, 0.001, 0);
      executeGraph(graph, reg, { now: 0, dt: 1 / 60 });
    }
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    // target.yaw should reflect the user's accumulated input, NOT the auto chase.
    expect(cam.target.yaw).toBeCloseTo(0.001 * 60, 4);
  });

  it("auto-yaw can be disabled globally via params.followBodyYaw = false", () => {
    const { reg, graph } = autoSetup();
    writeBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID), (d) => {
      d.params.followBodyYaw = false;
      d.target.yaw = 0;
      d.state.followedBodyYaw = 1.5;
      d.state.timeSinceLookInputSec = 999;
      d.pos = [-6.54, 2.6, 0];
      d.pivot.position = [0, 0, 0];
      d.target.pitch = Math.atan2(2.6, 6);
      d.params.distance = Math.hypot(6, 2.6);
    });
    setLook(reg, 0, 0);
    tickN(reg, graph, 60);
    const cam = readBuffer(reg.getBuffer<CameraBufferData>(CAMERA_BUFFER_ID));
    expect(cam.target.yaw).toBeCloseTo(0, 6);  // chase disabled, yaw stays put
  });
});
