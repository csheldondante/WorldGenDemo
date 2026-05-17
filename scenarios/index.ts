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
import { test as steepHillStuck } from "./steep-hill-stuck";
import { test as cliffRunoff } from "./cliff-runoff";
import { test as circleRunning } from "./circle-running";
import { test as cylinderSlopeClimb } from "./cylinder-slope-climb";
import { test as halfpipeAxisTraverse } from "./halfpipe-axis-traverse";
import { test as cameraHillCrest } from "./camera-hill-crest";
import { test as cameraStareDown } from "./camera-stare-down";

export const SCENARIOS: Record<string, BufferTest> = {
  [flatPlaneForward.name]: flatPlaneForward,
  [heightmapHillTraverse.name]: heightmapHillTraverse,
  [cameraLookInput.name]: cameraLookInput,
  [steepHillStuck.name]: steepHillStuck,
  [cliffRunoff.name]: cliffRunoff,
  [circleRunning.name]: circleRunning,
  [cylinderSlopeClimb.name]: cylinderSlopeClimb,
  [halfpipeAxisTraverse.name]: halfpipeAxisTraverse,
  [cameraHillCrest.name]: cameraHillCrest,
  [cameraStareDown.name]: cameraStareDown,
};

export function getScenario(name: string): BufferTest {
  const s = SCENARIOS[name];
  if (!s) {
    const available = Object.keys(SCENARIOS).sort().join(", ");
    throw new Error(`unknown scenario "${name}". available: ${available}`);
  }
  return s;
}
