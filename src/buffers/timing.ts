import { createBuffer, type Buffer } from "../runtime/buffer";

export interface TimingBufferData {
  /** Per-stage milliseconds, written by whichever system measured them. */
  stages: Record<string, number>;
  /** Total ms from rebuild start to last WorldReady. */
  totalRebuildMs: number;
  /** Pipeline warnings surfaced by AssetPlacementSystem etc. */
  warnings: string[];
}

export const TIMING_BUFFER_ID = "timing";

export function createTimingBuffer(): Buffer<TimingBufferData> {
  return createBuffer<TimingBufferData>({
    id: TIMING_BUFFER_ID,
    description: "Per-stage timing metrics + warnings. Read by HudSystem; written by every system that times itself.",
    initial: { stages: {}, totalRebuildMs: 0, warnings: [] },
  });
}
