/**
 * Scenario registry. Each scenario is a TS module exporting `scenario`
 * (a `ScenarioDescriptor`). The runner imports by name through this table.
 *
 * Convention: scenario name = filename stem. Keep names kebab-case.
 */
import type { ScenarioDescriptor } from "../src/lib/testing/scenarioHarness";

import { scenario as flatPlaneForward } from "./flat-plane-forward";

export const SCENARIOS: Record<string, ScenarioDescriptor> = {
  [flatPlaneForward.name]: flatPlaneForward,
};

export function getScenario(name: string): ScenarioDescriptor {
  const s = SCENARIOS[name];
  if (!s) {
    const available = Object.keys(SCENARIOS).sort().join(", ");
    throw new Error(`unknown scenario "${name}". available: ${available}`);
  }
  return s;
}
