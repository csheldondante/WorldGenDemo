import * as THREE from "three";

export interface FlyCamHandle {
  camera: THREE.PerspectiveCamera;
  update(dtSec: number): void;
  dispose(): void;
  setAttached(el: HTMLElement, hintEl: HTMLElement | null): void;
  setStart(position: [number, number, number], yaw: number, pitch: number): void;
}

/**
 * Creative-mode-style fly camera:
 *   WASD  — move on the XZ ground plane (yaw-only, never affected by pitch)
 *   Space — up
 *   Ctrl/C — down
 *   Shift — boost
 *   Mouse-look via pointer lock (click canvas to engage, esc to release)
 */
export function createFlyCam(): FlyCamHandle {
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 800);
  // Default start; main app will override via setStart based on map size.
  camera.position.set(0, 8, 60);

  const keys = new Set<string>();
  let yaw = 0;     // rotation around world Y, 0 means looking down -Z
  let pitch = 0;   // rotation around camera X
  let attachedEl: HTMLElement | null = null;
  let hintEl: HTMLElement | null = null;
  let pointerLocked = false;

  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.code);
    // Prevent space from scrolling the page
    if (e.code === "Space") e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  const onMouseMove = (e: MouseEvent) => {
    if (!pointerLocked) return;
    const sens = 0.0022;
    yaw -= e.movementX * sens;
    pitch -= e.movementY * sens;
    const lim = Math.PI / 2 - 0.05;
    if (pitch > lim) pitch = lim;
    if (pitch < -lim) pitch = -lim;
  };
  document.addEventListener("mousemove", onMouseMove);

  const onPLChange = () => {
    pointerLocked = !!document.pointerLockElement;
    if (hintEl) hintEl.classList.toggle("hidden", pointerLocked);
  };
  document.addEventListener("pointerlockchange", onPLChange);

  const onClick = () => {
    if (!attachedEl) return;
    if (!document.pointerLockElement) attachedEl.requestPointerLock();
  };

  // Apply initial orientation
  camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));

  return {
    camera,
    update(dt: number) {
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      const boost = (keys.has("ShiftLeft") || keys.has("ShiftRight")) ? 2.4 : 1.0;
      const speed = 14 * boost * dt;

      // Forward derived from the actual camera quaternion (more robust than yaw-only math)
      // and projected onto the XZ ground plane, so look-up/down does not affect WASD travel.
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      // Right = forward × up (Y-up, right-handed)
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));

      let dx = 0, dz = 0, dy = 0;
      if (keys.has("KeyW")) { dx += fwd.x;   dz += fwd.z; }
      if (keys.has("KeyS")) { dx -= fwd.x;   dz -= fwd.z; }
      if (keys.has("KeyD")) { dx += right.x; dz += right.z; }
      if (keys.has("KeyA")) { dx -= right.x; dz -= right.z; }
      if (keys.has("Space")) dy += 1;
      if (keys.has("KeyC") || keys.has("ControlLeft") || keys.has("ControlRight")) dy -= 1;

      const len = Math.hypot(dx, dz);
      if (len > 0) { dx /= len; dz /= len; }

      camera.position.x += dx * speed;
      camera.position.z += dz * speed;
      camera.position.y += dy * speed;
    },
    setAttached(el: HTMLElement, hint: HTMLElement | null) {
      if (attachedEl) attachedEl.removeEventListener("click", onClick);
      attachedEl = el;
      hintEl = hint;
      attachedEl.addEventListener("click", onClick);
    },
    setStart(position, newYaw, newPitch) {
      camera.position.set(position[0], position[1], position[2]);
      yaw = newYaw;
      pitch = newPitch;
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onPLChange);
      if (attachedEl) attachedEl.removeEventListener("click", onClick);
    },
  };
}
