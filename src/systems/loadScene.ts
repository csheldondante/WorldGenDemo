import { readBuffer, writeBuffer } from "../runtime/buffer";
import type { SystemDescriptor } from "../runtime/system";
import { STATE_MACHINE_BUFFER_ID, type StateMachineBufferData } from "../buffers/stateMachine";
import { EVENT_BUFFER_ID } from "../buffers/event";
import { TIMING_BUFFER_ID, type TimingBufferData } from "../buffers/timing";
import { STATE_MACHINE_SYSTEM_ID, type RuntimeEvent } from "../runtime/stateMachine";
import { loadScene, type LoadedScene } from "../map/loadScene";

export const LOAD_SCENE_SYSTEM_ID = "loadSceneSystem";

/**
 * Owns the async fetch of a scene's PNG + JSON.
 *
 * Active only while the SM is in "Loading" state. Reads StateMachineBuffer.pendingLoad,
 * kicks off `loadScene(name)` once per requested scene, and on resolution emits a
 * `RebuildRequested` event which transitions the SM to Rebuilding next tick.
 *
 * Stays synchronous in `execute`; the fetch promise resolves asynchronously and
 * is polled here. If the fetch fails, the error is recorded in TimingBuffer.warnings
 * and the SM remains in Loading until a new LoadRequested arrives.
 */
export function createLoadSceneSystem(): SystemDescriptor {
  type FetchState =
    | { status: "idle" }
    | { status: "in-flight"; sceneName: string }
    | { status: "ready"; sceneName: string; result: LoadedScene }
    | { status: "error"; sceneName: string; error: Error };
  let fetchState: FetchState = { status: "idle" };

  function extractPixels(image: HTMLImageElement, w: number, h: number): Uint8ClampedArray {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }

  return {
    id: LOAD_SCENE_SYSTEM_ID,
    description: "Async-fetches the scene PNG + JSON when state=Loading; emits RebuildRequested when the bytes arrive.",
    buffers: [
      { id: STATE_MACHINE_BUFFER_ID, access: "read" },
      { id: EVENT_BUFFER_ID, access: "readwrite" },
      { id: TIMING_BUFFER_ID, access: "write" },
    ],
    runsAfter: [STATE_MACHINE_SYSTEM_ID],
    execute: ({ buffer }) => {
      const sm = readBuffer(buffer<StateMachineBufferData>(STATE_MACHINE_BUFFER_ID));
      if (sm.state !== "Loading") return;
      if (!sm.pendingLoad) return;
      const requested = sm.pendingLoad.sceneName;

      // If a different scene is requested, drop any in-flight or stale state and start over.
      if (
        (fetchState.status === "in-flight" || fetchState.status === "ready" || fetchState.status === "error") &&
        fetchState.sceneName !== requested
      ) {
        fetchState = { status: "idle" };
      }

      // Kick off a fetch if idle
      if (fetchState.status === "idle") {
        const sceneName = requested;
        fetchState = { status: "in-flight", sceneName };
        loadScene(sceneName).then(
          (result) => {
            // Only adopt the result if we still want this scene
            if (fetchState.status === "in-flight" && fetchState.sceneName === sceneName) {
              fetchState = { status: "ready", sceneName, result };
            }
          },
          (error: unknown) => {
            const err = error instanceof Error ? error : new Error(String(error));
            if (fetchState.status === "in-flight" && fetchState.sceneName === sceneName) {
              fetchState = { status: "error", sceneName, error: err };
            }
          },
        );
        return;
      }

      // Surface error to HUD via TimingBuffer.warnings; clear so the user can re-trigger.
      if (fetchState.status === "error") {
        const timing = buffer<TimingBufferData>(TIMING_BUFFER_ID);
        const msg = `load failed: ${fetchState.error.message}`;
        writeBuffer(timing, (d) => {
          if (!d.warnings.includes(msg)) d.warnings = [...d.warnings, msg];
        });
        // eslint-disable-next-line no-console
        console.error(fetchState.error);
        fetchState = { status: "idle" }; // user can dispatch LoadRequested again
        return;
      }

      // Ready: emit RebuildRequested with the synthesized payload.
      if (fetchState.status === "ready") {
        const r = fetchState.result;
        const events = buffer<RuntimeEvent[]>(EVENT_BUFFER_ID);
        writeBuffer(events, (d) => {
          d.push({
            type: "RebuildRequested",
            payload: {
              sceneName: fetchState.status === "ready" ? fetchState.sceneName : r.scene.name,
              pixels: extractPixels(r.image, r.labelMap.width, r.labelMap.height),
              width: r.labelMap.width,
              height: r.labelMap.height,
              scene: r.scene,
              image: r.image,
            },
          });
        });
        fetchState = { status: "idle" };
      }
    },
  };
}
