/**
 * Scenario registry. Each scenario is a TS module exporting `scenario` and
 * `applyScenarioInput`. The CLI runner (`scripts/runScenario.ts`) imports by
 * name and looks the entry up here.
 *
 * Convention: scenario name = filename stem. Keep names kebab-case.
 */
import type { ScenarioDescriptor } from "../src/lib/testing/scenarioHarness";
import type { Registry } from "../src/runtime/registry";

import { scenario as flatPlaneForward, applyScenarioInput as flatPlaneApply } from "./flat-plane-forward";

export type InputApplier = (reg: Registry, event: {
  tick: number;
  moveAxis?: { x: number; y: number };
  lookDelta?: { yaw: number; pitch: number };
  jumpPressed?: boolean;
} | null) => void;

export interface ScenarioEntry {
  scenario: ScenarioDescriptor;
  applyInput: InputApplier;
}

export const SCENARIOS: Record<string, ScenarioEntry> = {
  [flatPlaneForward.name]: { scenario: flatPlaneForward, applyInput: flatPlaneApply },
};

export function getScenario(name: string): ScenarioEntry {
  const entry = SCENARIOS[name];
  if (!entry) {
    const available = Object.keys(SCENARIOS).sort().join(", ");
    throw new Error(`unknown scenario "${name}". available: ${available}`);
  }
  return entry;
}
