import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createRegistry } from "../../src/runtime/registry";
import { writeBuffer } from "../../src/runtime/buffer";
import { buildExecutionGraph } from "../../src/runtime/graph";
import { executeGraph } from "../../src/runtime/scheduler";
import { createCameraBuffer } from "../../src/buffers/camera";
import { createRenderRefsBuffer } from "../../src/buffers/renderRefs";
import { createRenderSystem } from "../../src/systems/render";

describe("RenderSystem (camera mirror)", () => {
  it("CameraBuffer.pos mirrors into THREE.PerspectiveCamera.position", () => {
    const reg = createRegistry();
    const cam = createCameraBuffer();
    const refs = createRenderRefsBuffer();
    reg.registerBuffer(cam);
    reg.registerBuffer(refs);
    reg.registerSystem(createRenderSystem());

    // Stub Three.js handles. Render call needs scene + renderer; we provide
    // mock renderer with a no-op render() so the mirror still runs.
    const threeCam = new THREE.PerspectiveCamera(70, 1, 0.1, 800);
    const fakeRenderer = { render: () => {} } as unknown as THREE.WebGLRenderer;
    const fakeScene = new THREE.Scene();
    writeBuffer(refs, (d) => {
      d.threeCamera = threeCam;
      d.renderer = fakeRenderer;
      d.scene = fakeScene;
    });
    // Quaternion mirroring world-Y yaw=π/4, pitch=0 (camera looking down (-sin π/4, 0, -cos π/4))
    // is the y-axis rotation by half-angle: q = [0, sin(π/8), 0, cos(π/8)].
    const halfYaw = Math.PI / 8;
    writeBuffer(cam, (d) => {
      d.pos = [10, 20, 30];
      d.quaternion = [0, Math.sin(halfYaw), 0, Math.cos(halfYaw)];
      d.fov = 60;
      d.aspect = 16 / 9;
    });

    const g = buildExecutionGraph({ id: "g", nodes: ["renderSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    expect(threeCam.position.x).toBeCloseTo(10);
    expect(threeCam.position.y).toBeCloseTo(20);
    expect(threeCam.position.z).toBeCloseTo(30);
    expect(threeCam.fov).toBeCloseTo(60);
    expect(threeCam.aspect).toBeCloseTo(16 / 9);
    // Quaternion comes through verbatim: forward (camera-local -Z) maps to
    // (-sin(π/4), 0, -cos(π/4)) in world space.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(threeCam.quaternion);
    expect(fwd.x).toBeCloseTo(-Math.sin(Math.PI / 4), 5);
    expect(fwd.y).toBeCloseTo(0, 5);
    expect(fwd.z).toBeCloseTo(-Math.cos(Math.PI / 4), 5);
  });

  it("does nothing when threeCamera is null (no Three.js wired yet)", () => {
    const reg = createRegistry();
    const cam = createCameraBuffer();
    const refs = createRenderRefsBuffer();
    reg.registerBuffer(cam);
    reg.registerBuffer(refs);
    reg.registerSystem(createRenderSystem());
    const g = buildExecutionGraph({ id: "g", nodes: ["renderSystem"], registry: reg });
    expect(() => executeGraph(g, reg, { dt: 0, now: 0 })).not.toThrow();
  });
});
