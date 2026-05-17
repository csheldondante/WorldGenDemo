/**
 * Render-only debug gizmos for the scenario harness:
 *
 *   - Character body frame as a small RGB axis cross (R=right, G=up, B=forward)
 *     anchored at the followed character's transform position. Axes are the
 *     SURFACE PUCK's frame, not the rendered/animated body — i.e. the frame
 *     the root motion controller actually operates in:
 *       up      = surfaceAttachment.sample.normal (or gravity-up if airborne)
 *       forward = R_Y(t.yaw)·(0,0,-1), projected onto the up-tangent plane
 *       right   = cross(up, forward)
 *     Procedural animation (bodyLean, chainDynamics, footIk) is layered on
 *     top of this frame and does NOT feed back into root motion — useful to
 *     see directly when the gizmo looks "right" but the rendered body looks
 *     wrong.
 *
 *   - Camera pivot dot at `cam.pivot.position`. Tracks the orbit centre,
 *     which lags the character slightly under the pivotResponsiveness chase.
 *
 * Gating: the gizmos render only when `scene.userData.debugGizmos` is set,
 * which `applyScenarioBackdrop` does for scenario playback. Normal play mode
 * never sets this, so the system stays inert there (single read per tick).
 *
 * Closure-cached THREE objects follow the same pattern as
 * SkeletonDebugRenderSystem and CharacterRenderSyncSystem (render-side perf
 * optimisation; no gameplay state hidden).
 */
import * as THREE from "three";
import { readBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { TRANSFORM_BUFFER_ID, type TransformBufferData } from "../buffers/transform";
import {
  CHARACTER_CONTROLLER_BUFFER_ID,
  type CharacterControllerBufferData,
} from "../buffers/characterController";
import {
  SURFACE_ATTACHMENT_BUFFER_ID,
  type SurfaceAttachmentBufferData,
} from "../buffers/surfaceAttachment";
import { INPUT_MAP_BUFFER_ID, type InputMapBufferData } from "../buffers/inputMap";
import { CAMERA_BUFFER_ID, type CameraBufferData } from "../buffers/camera";
import { VOLUME_FIELD_BUFFER_ID, type VolumeFieldBufferData } from "../buffers/volumeField";
import { RENDER_REFS_BUFFER_ID, type RenderRefsBufferData } from "../buffers/renderRefs";
import { pickGravity, sortVolumesByPriority } from "../lib/math/gravityVolume";
import { CHARACTER_CONTROLLER_SYSTEM_ID } from "./characterController";
import { CAMERA_ORBIT_SYSTEM_ID } from "./cameraOrbit";
import { BODY_LEAN_SYSTEM_ID } from "./bodyLean";
import { RENDER_SYSTEM_ID } from "./render";

export const DEBUG_GIZMO_SYSTEM_ID = "debugGizmoSystem";

const AXIS_LENGTH = 1.2;
const PIVOT_DOT_SIZE = 0.15;

interface GizmoRefs {
  axes: THREE.Group;
  axesPositions: Float32Array;       // 6 vertices × 3 axes = 18 floats
  axesAttr: THREE.BufferAttribute;
  pivotDot: THREE.Mesh;
}

export function createDebugGizmoSystem(): SystemDescriptor {
  let refs: GizmoRefs | null = null;

  function buildGizmo(scene: THREE.Scene): GizmoRefs {
    const axes = new THREE.Group();
    axes.name = "debugGizmo_characterAxes";
    axes.frustumCulled = false;
    // One BufferGeometry per axis so each can have its own color. Vertices
    // are written into shared Float32Array slots and updated each tick.
    const positions = new Float32Array(6 * 3);
    const attr = new THREE.BufferAttribute(positions, 3);
    function makeAxis(color: number, offset: number): THREE.Line {
      const geom = new THREE.BufferGeometry();
      // Each axis is a 2-vertex slice of the shared attribute.
      const slice = new THREE.BufferAttribute(
        positions.subarray(offset * 6, offset * 6 + 6),
        3,
      );
      geom.setAttribute("position", slice);
      const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
      const line = new THREE.Line(geom, mat);
      line.frustumCulled = false;
      line.renderOrder = 999;
      return line;
    }
    axes.add(makeAxis(0xff5555, 0)); // right  — red
    axes.add(makeAxis(0x55ff55, 1)); // up     — green
    axes.add(makeAxis(0x6699ff, 2)); // forward — blue

    const pivotGeom = new THREE.SphereGeometry(PIVOT_DOT_SIZE, 12, 8);
    const pivotMat = new THREE.MeshBasicMaterial({ color: 0xffaa22, depthTest: false, transparent: true, opacity: 0.85 });
    const pivotDot = new THREE.Mesh(pivotGeom, pivotMat);
    pivotDot.name = "debugGizmo_pivotDot";
    pivotDot.frustumCulled = false;
    pivotDot.renderOrder = 999;

    scene.add(axes);
    scene.add(pivotDot);
    return { axes, axesPositions: positions, axesAttr: attr, pivotDot };
  }

  return {
    id: DEBUG_GIZMO_SYSTEM_ID,
    description:
      "Render-only debug gizmos for scenarios: RGB axes at the followed character (surface-puck frame — up=surfaceNormal, forward=projected yaw, right=cross) + a small dot at cam.pivot.position. Gated by scene.userData.debugGizmos which applyScenarioBackdrop sets in scenario mode. Inert in normal play.",
    buffers: [
      { id: TRANSFORM_BUFFER_ID, access: "read" },
      { id: CHARACTER_CONTROLLER_BUFFER_ID, access: "read" },
      { id: SURFACE_ATTACHMENT_BUFFER_ID, access: "read" },
      { id: INPUT_MAP_BUFFER_ID, access: "read" },
      { id: CAMERA_BUFFER_ID, access: "read" },
      { id: VOLUME_FIELD_BUFFER_ID, access: "read" },
      { id: RENDER_REFS_BUFFER_ID, access: "read" },
    ],
    runsAfter: [CHARACTER_CONTROLLER_SYSTEM_ID, BODY_LEAN_SYSTEM_ID, CAMERA_ORBIT_SYSTEM_ID],
    // Mutates scene contents (line geometry positions); must precede RenderSystem
    // which reads renderRefs.scene to draw.
    runsBefore: [RENDER_SYSTEM_ID],
    execute: ({ buffer }) => {
      const refsBuf = readBuffer(buffer<RenderRefsBufferData>(RENDER_REFS_BUFFER_ID));
      if (!refsBuf.scene) return;
      const flags = (refsBuf.scene.userData as { debugGizmos?: { characterAxes: boolean; pivotMarker: boolean } }).debugGizmos;
      if (!flags) return;
      const cc = readBuffer(buffer<CharacterControllerBufferData>(CHARACTER_CONTROLLER_BUFFER_ID));
      const targetId = cc.byEntity.keys().next().value as number | undefined;
      if (targetId === undefined) return;
      const transforms = readBuffer(buffer<TransformBufferData>(TRANSFORM_BUFFER_ID));
      const t = transforms.byEntity.get(targetId);
      if (!t) return;
      const attach = readBuffer(buffer<SurfaceAttachmentBufferData>(SURFACE_ATTACHMENT_BUFFER_ID));
      const sa = attach.byEntity.get(targetId);
      const cam = readBuffer(buffer<CameraBufferData>(CAMERA_BUFFER_ID));
      const im = readBuffer(buffer<InputMapBufferData>(INPUT_MAP_BUFFER_ID));
      const vol = readBuffer(buffer<VolumeFieldBufferData>(VOLUME_FIELD_BUFFER_ID));

      if (!refs) refs = buildGizmo(refsBuf.scene);

      // ---- Compute the surface-puck frame (where the puck WANTS to face) ----
      // Up: surface normal if attached; else negative-gravity if airborne.
      let upX: number, upY: number, upZ: number;
      if (sa && sa.sample) {
        upX = sa.sample.normal[0];
        upY = sa.sample.normal[1];
        upZ = sa.sample.normal[2];
      } else {
        const sortedVolumes = sortVolumesByPriority(vol.volumes);
        const g = pickGravity(sortedVolumes, vol.gravity, t.position);
        const gLen = Math.hypot(g[0], g[1], g[2]) || 1;
        upX = -g[0] / gLen;
        upY = -g[1] / gLen;
        upZ = -g[2] / gLen;
      }
      // Forward: derive from the camera's WORLD-SPACE look direction + the
      // player's move-input angle. This is the puck's "desired facing" — the
      // ground truth the orientation controller is trying to track — NOT the
      // body's actual rendered yaw (which is limited by the world-Y Euler
      // representation on non-flat-Y gravity). Showing the desired direction
      // makes the gizmo a stable reference for diagnosing the body-yaw
      // representation issue separately.
      //
      //   Ft   = normalize(camLookDir − (camLookDir·N)·N)    // camera fwd projected onto tangent
      //   Rt   = cross(N, Ft)                                // lateral tangent
      //   α    = atan2(moveX, moveY)                          // 0=forward, π/2=right
      //   dFwd = Ft·cos(α) + Rt·sin(α)
      //
      // When idle, dFwd = Ft (α = 0).
      const camLookX = cam.lookDir[0];
      const camLookY = cam.lookDir[1];
      const camLookZ = cam.lookDir[2];
      const LdotN = camLookX * upX + camLookY * upY + camLookZ * upZ;
      let FtX = camLookX - LdotN * upX;
      let FtY = camLookY - LdotN * upY;
      let FtZ = camLookZ - LdotN * upZ;
      let FtLen = Math.hypot(FtX, FtY, FtZ);
      if (FtLen < 1e-6) {
        // Camera looks directly along surface normal — Ft undefined.
        // Fall back to a world axis least aligned with up to keep the gizmo
        // pointing somewhere meaningful instead of flickering.
        const ax = Math.abs(upX);
        const ay = Math.abs(upY);
        const az = Math.abs(upZ);
        if (ax <= ay && ax <= az) { FtX = 1; FtY = 0; FtZ = 0; }
        else if (ay <= az) { FtX = 0; FtY = 1; FtZ = 0; }
        else { FtX = 0; FtY = 0; FtZ = 1; }
        const d2 = FtX * upX + FtY * upY + FtZ * upZ;
        FtX -= d2 * upX; FtY -= d2 * upY; FtZ -= d2 * upZ;
        FtLen = Math.hypot(FtX, FtY, FtZ) || 1;
      }
      FtX /= FtLen; FtY /= FtLen; FtZ /= FtLen;
      // Right-tangent.
      const RtX = upY * FtZ - upZ * FtY;
      const RtY = upZ * FtX - upX * FtZ;
      const RtZ = upX * FtY - upY * FtX;
      // Apply move-input angle to derive desired facing.
      const alpha = Math.atan2(im.moveAxis.x, im.moveAxis.y);
      const ca = Math.cos(alpha);
      const sa_ = Math.sin(alpha);
      const fwdX = FtX * ca + RtX * sa_;
      const fwdY = FtY * ca + RtY * sa_;
      const fwdZ = FtZ * ca + RtZ * sa_;
      // Right = cross(up, forward).
      const rgtX = upY * fwdZ - upZ * fwdY;
      const rgtY = upZ * fwdX - upX * fwdZ;
      const rgtZ = upX * fwdY - upY * fwdX;

      // ---- Update axes geometry ----
      // Axis i occupies vertices [i*2, i*2+1] in the positions array.
      const px = t.position[0], py = t.position[1], pz = t.position[2];
      const positions = refs.axesPositions;
      if (flags.characterAxes) {
        refs.axes.visible = true;
        // right (red)
        positions[0] = px; positions[1] = py; positions[2] = pz;
        positions[3] = px + rgtX * AXIS_LENGTH; positions[4] = py + rgtY * AXIS_LENGTH; positions[5] = pz + rgtZ * AXIS_LENGTH;
        // up (green)
        positions[6] = px; positions[7] = py; positions[8] = pz;
        positions[9] = px + upX * AXIS_LENGTH; positions[10] = py + upY * AXIS_LENGTH; positions[11] = pz + upZ * AXIS_LENGTH;
        // forward (blue)
        positions[12] = px; positions[13] = py; positions[14] = pz;
        positions[15] = px + fwdX * AXIS_LENGTH; positions[16] = py + fwdY * AXIS_LENGTH; positions[17] = pz + fwdZ * AXIS_LENGTH;
        // Mark each per-axis BufferAttribute slice as dirty.
        for (const child of refs.axes.children) {
          const line = child as THREE.Line;
          (line.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        }
      } else {
        refs.axes.visible = false;
      }

      // ---- Update pivot dot ----
      if (flags.pivotMarker) {
        refs.pivotDot.visible = true;
        refs.pivotDot.position.set(cam.pivot.position[0], cam.pivot.position[1], cam.pivot.position[2]);
      } else {
        refs.pivotDot.visible = false;
      }
    },
  };
}
