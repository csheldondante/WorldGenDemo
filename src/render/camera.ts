import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";

export interface FlyCamHandle {
  camera: THREE.PerspectiveCamera;
  update(dtSec: number): void;
  dispose(): void;
  setAttached(el: HTMLElement, hintEl: HTMLElement | null): void;
  setStart(position: [number, number, number], yaw: number, pitch: number): void;
  /** Debug snapshot of current camera state */
  debug(): { pos: [number, number, number]; fwdXZ: [number, number]; yaw: number };
}

/**
 * Creative-mode-style fly camera using Three.js's canonical PointerLockControls.
 *
 *   WASD   — move on the XZ ground plane (controls.moveForward / moveRight project to XZ)
 *   Space  — up
 *   Ctrl/C — down
 *   Shift  — boost
 */
export function createFlyCam(): FlyCamHandle {
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 800);
  camera.position.set(0, 8, 60);

  const keys = new Set<string>();
  let attachedEl: HTMLElement | null = null;
  let hintEl: HTMLElement | null = null;
  // Lazily created when we know which element to attach to.
  let controls: PointerLockControls | null = null;

  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    if (e.code === "Space") e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const onClick = () => {
    if (controls && !controls.isLocked) controls.lock();
  };

  function ensureControls() {
    if (!controls && attachedEl) {
      controls = new PointerLockControls(camera, attachedEl);
      controls.addEventListener("lock", () => {
        if (hintEl) hintEl.classList.add("hidden");
      });
      controls.addEventListener("unlock", () => {
        if (hintEl) hintEl.classList.remove("hidden");
      });
    }
  }

  return {
    camera,
    update(dt: number) {
      ensureControls();
      const boost = (keys.has("ShiftLeft") || keys.has("ShiftRight")) ? 2.4 : 1.0;
      const speed = 14 * boost * dt;

      // Build a direction tuple, normalize, then translate via PointerLockControls
      // so XZ projection is handled by the canonical implementation.
      let f = 0, r = 0, u = 0;
      if (keys.has("KeyW")) f += 1;
      if (keys.has("KeyS")) f -= 1;
      if (keys.has("KeyD")) r += 1;
      if (keys.has("KeyA")) r -= 1;
      if (keys.has("Space")) u += 1;
      if (keys.has("KeyC") || keys.has("ControlLeft") || keys.has("ControlRight")) u -= 1;

      const horizLen = Math.hypot(f, r);
      if (controls && horizLen > 0) {
        // Normalize so diagonals don't move faster
        const nf = f / horizLen, nr = r / horizLen;
        controls.moveForward(nf * speed);
        controls.moveRight(nr * speed);
      }
      camera.position.y += u * speed;
    },
    setAttached(el: HTMLElement, hint: HTMLElement | null) {
      if (attachedEl) attachedEl.removeEventListener("click", onClick);
      attachedEl = el;
      hintEl = hint;
      attachedEl.addEventListener("click", onClick);
      ensureControls();
    },
    setStart(position, yaw, pitch) {
      camera.position.set(position[0], position[1], position[2]);
      // Apply yaw/pitch via the camera's quaternion (PointerLockControls reads from camera.rotation).
      camera.rotation.set(pitch, yaw, 0, "YXZ");
    },
    debug() {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const yaw = Math.atan2(-fwd.x, -fwd.z);
      return {
        pos: [camera.position.x, camera.position.y, camera.position.z],
        fwdXZ: [fwd.x, fwd.z],
        yaw,
      };
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (attachedEl) attachedEl.removeEventListener("click", onClick);
      if (controls) controls.dispose();
    },
  };
}
