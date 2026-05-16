/**
 * Scenario registry. Each scenario is a TS module exporting `test`
 * (a `BufferTest`). The runner imports by name through this table.
 *
 * Convention: scenario name = filename stem. Kebab-case.
 */
import type { BufferTest } from "../src/app/bufferTest";

import { test as flatPlaneForward } from "./flat-plane-forward";
import { test as heightmapHillTraverse } from "./heightmap-hill-traverse";
import { test as cameraLookInput } from "./camera-look-input";

export const SCENARIOS: Record<string, BufferTest> = {
  [flatPlaneForward.name]: flatPlaneForward,
  [heightmapHillTraverse.name]: heightmapHillTraverse,
  [cameraLookInput.name]: cameraLookInput,
};

export function getScenario(name: string): BufferTest {
  const s = SCENARIOS[name];
  if (!s) {
    const available = Object.keys(SCENARIOS).sort().join(", ");
    throw new Error(`unknown scenario "${name}". available: ${available}`);
  }
  return s;
}
