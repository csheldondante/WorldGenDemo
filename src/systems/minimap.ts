import * as THREE from "three";
import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { WORLD_DATA_BUFFER_ID, type WorldDataBufferData } from "../buffers/worldData";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { CAMERA_FOLLOW_SYSTEM_ID } from "./cameraFollow";
import { RENDER_SYSTEM_ID } from "./render";

export const MINIMAP_SYSTEM_ID = "minimapSystem";
const MINIMAP_SIZE = 200;

/**
 * Renders the source bitmap into a 200×200 overlay with the camera position
 * (yellow dot) and FOV wedge. Reads CameraBuffer + WorldDataBuffer.image,
 * writes its DOM canvas (RenderRefsBuffer.minimapEl).
 */
export function createMinimapSystem(): SystemDescriptor {
  let canvas: HTMLCanvasElement | null = null;
  let lastImage: HTMLImageElement | null = null;
  let attachedTo: HTMLElement | null = null;

  return {
    id: MINIMAP_SYSTEM_ID,
    description: "Draws the source bitmap with camera position + FOV wedge into an overlay canvas.",
    buffers: [
      { id: CAMERA_BUFFER_ID, access: "read" },
      { id: WORLD_DATA_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "readwrite" },
    ],
    runsAfter: [CAMERA_FOLLOW_SYSTEM_ID, RENDER_SYSTEM_ID],
    execute: ({ buffer }) => {
      const cam = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const world = readBuffer(buffer<WorldDataBufferData>(WORLD_DATA_BUFFER_ID));
      const refsBuf = buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID);
      const refs = readBuffer(refsBuf);
      if (!refs.panelEl || !world.image || !world.labelMap) return;

      // Lazy-create the canvas + attach to panel
      if (!canvas) {
        const wrap = document.createElement("div");
        wrap.style.cssText = `
          position: absolute; top: 50px; right: 10px; z-index: 5;
          width: ${MINIMAP_SIZE}px; height: ${MINIMAP_SIZE}px; background: #000;
          border: 1px solid #444; border-radius: 4px; overflow: hidden;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5); pointer-events: none;
        `;
        canvas = document.createElement("canvas");
        canvas.width = MINIMAP_SIZE;
        canvas.height = MINIMAP_SIZE;
        canvas.style.cssText = "display:block; width:100%; height:100%; image-rendering: pixelated;";
        wrap.appendChild(canvas);
        refs.panelEl.appendChild(wrap);
        attachedTo = wrap;
        writeBuffer(refsBuf, (d) => { d.minimapEl = wrap; });
      }
      // If world image changed (rebuild), force redraw of the underlying bitmap
      if (lastImage !== world.image) lastImage = world.image;

      const ctx = canvas!.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, MINIMAP_SIZE, MINIMAP_SIZE);
      ctx.drawImage(world.image, 0, 0, MINIMAP_SIZE, MINIMAP_SIZE);

      // Compass
      ctx.font = "bold 12px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "#000";
      ctx.shadowColor = "rgba(255,255,255,0.85)";
      ctx.shadowBlur = 3;
      ctx.fillText("N", MINIMAP_SIZE * 0.5, 8);
      ctx.fillText("S", MINIMAP_SIZE * 0.5, MINIMAP_SIZE - 8);
      ctx.fillText("W", 8, MINIMAP_SIZE * 0.5);
      ctx.fillText("E", MINIMAP_SIZE - 8, MINIMAP_SIZE * 0.5);
      ctx.shadowBlur = 0;

      const lm = world.labelMap;
      const worldW = lm.width * lm.tileSize;
      const worldH = lm.height * lm.tileSize;
      const px = (cam.pos[0] + worldW * 0.5) / worldW * MINIMAP_SIZE;
      const py = (cam.pos[2] + worldH * 0.5) / worldH * MINIMAP_SIZE;

      // Camera forward in world XZ (derived from yaw)
      const fwd = new THREE.Vector3(0, 0, -1).applyEuler(new THREE.Euler(cam.pitch, cam.yaw, 0, "YXZ"));
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
      fwd.normalize();
      const halfFov = (cam.fov * Math.PI / 180) * 0.5;
      const fL = new THREE.Vector3(fwd.x, 0, fwd.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), halfFov);
      const fR = new THREE.Vector3(fwd.x, 0, fwd.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -halfFov);
      const coneLen = 24;

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

      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = "#ffe650";
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + fwd.x * 12, py + fwd.z * 12);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      void attachedTo; // referenced for retention; lints quiet
    },
  };
}
