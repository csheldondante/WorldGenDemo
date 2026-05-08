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
    writeBuffer(cam, (d) => {
      d.pos = [10, 20, 30];
      d.yaw = Math.PI / 4;
      d.pitch = -0.1;
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
    // Quaternion: yaw=π/4, pitch=-0.1 → camera looks toward (-sin(π/4), small, -cos(π/4))
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(threeCam.quaternion);
    expect(fwd.x).toBeCloseTo(-Math.sin(Math.PI / 4), 1);
    expect(fwd.z).toBeCloseTo(-Math.cos(Math.PI / 4), 1);
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
