import { startWorld, startScenarioWorld } from "./app/world";

/**
 * Top-level entry. Panel-switching + mode requests now live entirely in
 * the runtime-driven mode-switcher dropdown (see
 * `src/app/world.ts:attachModeSwitcher`); main.ts just hands the panel
 * elements to the world startup. The dropdown's change handler is
 * responsible for toggling .active on the right panel + emitting the
 * matching event.
 */
const panels: Record<string, HTMLElement> = {
  world: document.getElementById("panel-world")!,
  builder: document.getElementById("panel-builder")!,
};

const url = new URL(location.href);
const scenarioName = url.searchParams.get("scenario");

const worldOpts = {
  hudEl: document.getElementById("hud") as HTMLElement,
  hintEl: document.getElementById("hint") as HTMLElement,
  panelEl: panels.world,
  builderPanelEl: panels.builder,
};

const _world = scenarioName
  ? startScenarioWorld(worldOpts, scenarioName)
  : startWorld(worldOpts);
void _world;
