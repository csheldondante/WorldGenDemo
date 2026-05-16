/**
 * Scenario registry. Each scenario is a TS module exporting `test`
 * (a `BufferTest`). The runner imports by name through this table.
 *
 * Convention: scenario name = filename stem. Kebab-case.
 */
import type { BufferTest } from "../src/app/bufferTest";

import { test as flatPlaneForward } from "./flat-plane-forward";

export const SCENARIOS: Record<string, BufferTest> = {
  [flatPlaneForward.name]: flatPlaneForward,
};

export function getScenario(name: string): BufferTest {
  const s = SCENARIOS[name];
  if (!s) {
    const available = Object.keys(SCENARIOS).sort().join(", ");
    throw new Error(`unknown scenario "${name}". available: ${available}`);
  }
  return s;
}
