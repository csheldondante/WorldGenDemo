import * as THREE from "three";

export interface MinimapInput {
  image: HTMLImageElement;
  /** World X-extent = mapPixelsX * tileSize, same for Z. World origin is map center. */
  mapWidthPixels: number;
  mapHeightPixels: number;
  tileSize: number;
  camera: THREE.Camera;
  size?: number; // square edge in CSS pixels
}

export interface MinimapHandle {
  el: HTMLElement;
  update(): void;
  dispose(): void;
}

export function createMinimap(input: MinimapInput): MinimapHandle {
  const size = input.size ?? 200;
  const wrap = document.createElement("div");
  wrap.style.cssText = `
    position: absolute; top: 50px; right: 10px; z-index: 5;
    width: ${size}px; height: ${size}px; background: #000;
    border: 1px solid #444; border-radius: 4px; overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    pointer-events: none;
  `;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  canvas.style.cssText = "display:block; width:100%; height:100%; image-rendering: pixelated;";
  wrap.appendChild(canvas);

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  const worldW = input.mapWidthPixels * input.tileSize;
  const worldH = input.mapHeightPixels * input.tileSize;

  function update() {
    // Background: source bitmap
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(input.image, 0, 0, size, size);

    // Compass: N at top, S at bottom, E at right, W at left.
    // Using fillText with shadow so it's readable against any bitmap.
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#000";
    ctx.shadowColor = "rgba(255,255,255,0.85)";
    ctx.shadowBlur = 3;
    ctx.fillText("N", size * 0.5, 8);
    ctx.fillText("S", size * 0.5, size - 8);
    ctx.fillText("W", 8, size * 0.5);
    ctx.fillText("E", size - 8, size * 0.5);
    ctx.shadowBlur = 0;

    // Camera position in pixel space (note: world Z increases downward in our minimap,
    // because the bitmap row 0 is the top; we draw rows top-to-bottom)
    const cam = input.camera as THREE.PerspectiveCamera;
    const cx = cam.position.x;
    const cz = cam.position.z;
    // Map world -> minimap pixels. World x ∈ [-W/2, +W/2] -> minimap [0, size].
    const px = (cx + worldW * 0.5) / worldW * size;
    const py = (cz + worldH * 0.5) / worldH * size;

    // Camera forward in world XZ
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    // FOV cone (half-angle)
    const halfFov = (cam.fov * Math.PI / 180) * 0.5;
    const coneLen = 24;
    const fL = new THREE.Vector3(fwd.x, 0, fwd.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), halfFov);
    const fR = new THREE.Vector3(fwd.x, 0, fwd.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -halfFov);

    // Draw fov wedge
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + fL.x * coneLen, py + fL.z * coneLen);
    ctx.lineTo(px + fR.x * coneLen, py + fR.z * coneLen);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 230, 80, 0.25)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255, 230, 80, 0.65)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Position dot
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffe650";
    ctx.fill();
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Heading line
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + fwd.x * 12, py + fwd.z * 12);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  return {
    el: wrap,
    update,
    dispose() {
      wrap.remove();
    },
  };
}
