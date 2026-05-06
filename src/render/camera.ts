import * as THREE from "three";

export interface FlyCamHandle {
  camera: THREE.PerspectiveCamera;
  update(dtSec: number): void;
  dispose(): void;
  setAttached(el: HTMLElement, hintEl: HTMLElement | null): void;
}

export function createFlyCam(): FlyCamHandle {
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 500);
  camera.position.set(0, 12, 22);
  camera.lookAt(0, 0, 0);

  const keys = new Set<string>();
  let yaw = 0;
  let pitch = 0;
  let attachedEl: HTMLElement | null = null;
  let hintEl: HTMLElement | null = null;
  let pointerLocked = false;

  const onKeyDown = (e: KeyboardEvent) => keys.add(e.code);
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
  // Wired in setAttached.

  // Initialize yaw/pitch from current camera orientation
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, "YXZ");
  yaw = e.y;
  pitch = e.x;

  return {
    camera,
    update(dt: number) {
      camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
      const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 22 : 10) * dt;
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0);
      if (keys.has("KeyW")) camera.position.addScaledVector(forward, speed);
      if (keys.has("KeyS")) camera.position.addScaledVector(forward, -speed);
      if (keys.has("KeyA")) camera.position.addScaledVector(right, -speed);
      if (keys.has("KeyD")) camera.position.addScaledVector(right, speed);
      if (keys.has("Space")) camera.position.addScaledVector(up, speed);
      if (keys.has("KeyC") || keys.has("ControlLeft")) camera.position.addScaledVector(up, -speed);
    },
    setAttached(el: HTMLElement, hint: HTMLElement | null) {
      if (attachedEl) attachedEl.removeEventListener("click", onClick);
      attachedEl = el;
      hintEl = hint;
      attachedEl.addEventListener("click", onClick);
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
