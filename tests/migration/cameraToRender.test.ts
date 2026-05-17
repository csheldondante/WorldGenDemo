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
  it("CameraBuffer position + pivot mirrors into the THREE camera (gravity-aware lookAt)", () => {
    const reg = createRegistry();
    const cam = createCameraBuffer();
    const refs = createRenderRefsBuffer();
    reg.registerBuffer(cam);
    reg.registerBuffer(refs);
    reg.registerSystem(createRenderSystem());

    const threeCam = new THREE.PerspectiveCamera(70, 1, 0.1, 800);
    const fakeRenderer = { render: () => {} } as unknown as THREE.WebGLRenderer;
    const fakeScene = new THREE.Scene();
    writeBuffer(refs, (d) => {
      d.threeCamera = threeCam;
      d.renderer = fakeRenderer;
      d.scene = fakeScene;
    });
    // Camera at (10, 20, 30); looking at pivot (0, 20, 30) → forward = (-1, 0, 0).
    // Up = +Y (flat-gravity world).
    writeBuffer(cam, (d) => {
      d.pos = [10, 20, 30];
      d.pivot.position = [0, 20, 30];
      d.pivot.up = [0, 1, 0];
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
    // Camera should look toward pivot (-X direction from camera).
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(threeCam.quaternion);
    expect(fwd.x).toBeCloseTo(-1, 6);
    expect(fwd.y).toBeCloseTo(0, 6);
    expect(fwd.z).toBeCloseTo(0, 6);
  });

  it("camera up follows pivot.up — Mario-Galaxy-style worlds roll the view", () => {
    const reg = createRegistry();
    const cam = createCameraBuffer();
    const refs = createRenderRefsBuffer();
    reg.registerBuffer(cam);
    reg.registerBuffer(refs);
    reg.registerSystem(createRenderSystem());

    const threeCam = new THREE.PerspectiveCamera(70, 1, 0.1, 800);
    const fakeRenderer = { render: () => {} } as unknown as THREE.WebGLRenderer;
    const fakeScene = new THREE.Scene();
    writeBuffer(refs, (d) => {
      d.threeCamera = threeCam;
      d.renderer = fakeRenderer;
      d.scene = fakeScene;
    });
    // Player on the +X side of a sphere planetoid: pivot at (20, 0, 0),
    // gravity points toward origin so pivot.up = +X. Camera offset 6m along
    // -Z behind the player AND 2.6m further out in +X (the legacy "(0, 2.6, 6)"
    // offset, but in the gravity-aligned frame). With this pose, lookAt is
    // well-defined and the rendered "up" direction should align with +X.
    writeBuffer(cam, (d) => {
      d.pos = [22.6, 0, 6];
      d.pivot.position = [20, 0, 0];
      d.pivot.up = [1, 0, 0];
    });

    const g = buildExecutionGraph({ id: "g", nodes: ["renderSystem"], registry: reg });
    executeGraph(g, reg, { dt: 0, now: 0 });

    // The camera local +Y axis (its "up" in screen space) should map to
    // approximately +X in world space — gravity-up is now the screen-up axis.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(threeCam.quaternion);
    expect(up.x).toBeGreaterThan(0.9);
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
