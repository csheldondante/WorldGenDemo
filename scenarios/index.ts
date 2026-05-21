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
import { test as climbSteepWall } from "./climb-steep-wall";
import { test as climbSteepWallExtended } from "./climb-steep-wall-extended";
import { test as climbTallWall } from "./climb-tall-wall";
import { test as cliffRunoff } from "./cliff-runoff";
import { test as circleRunning } from "./circle-running";
import { test as halfpipeAxisTraverse } from "./halfpipe-axis-traverse";
import { test as cameraHillCrest } from "./camera-hill-crest";
import { test as cameraHillCrestExtended } from "./camera-hill-crest-extended";
import { test as cameraStareDown } from "./camera-stare-down";
import { test as cylinderGalaxy } from "./cylinder-galaxy";
import { test as sphereGalaxy } from "./sphere-galaxy";
import { test as torusGalaxy } from "./torus-galaxy";

export const SCENARIOS: Record<string, BufferTest> = {
  [flatPlaneForward.name]: flatPlaneForward,
  [heightmapHillTraverse.name]: heightmapHillTraverse,
  [cameraLookInput.name]: cameraLookInput,
  [steepHillStuck.name]: steepHillStuck,
  [climbSteepWall.name]: climbSteepWall,
  [climbSteepWallExtended.name]: climbSteepWallExtended,
  [climbTallWall.name]: climbTallWall,
  [cliffRunoff.name]: cliffRunoff,
  [circleRunning.name]: circleRunning,
  [halfpipeAxisTraverse.name]: halfpipeAxisTraverse,
  [cameraHillCrest.name]: cameraHillCrest,
  [cameraHillCrestExtended.name]: cameraHillCrestExtended,
  [cameraStareDown.name]: cameraStareDown,
  [cylinderGalaxy.name]: cylinderGalaxy,
  [sphereGalaxy.name]: sphereGalaxy,
  [torusGalaxy.name]: torusGalaxy,
};

export function getScenario(name: string): BufferTest {
  const s = SCENARIOS[name];
  if (!s) {
    const available = Object.keys(SCENARIOS).sort().join(", ");
    throw new Error(`unknown scenario "${name}". available: ${available}`);
  }
  return s;
}
