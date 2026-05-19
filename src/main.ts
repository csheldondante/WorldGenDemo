import { startWorld, startScenarioWorld } from "./app/world";

const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const panels: Record<string, HTMLElement> = {
  world: document.getElementById("panel-world")!,
  builder: document.getElementById("panel-builder")!,
};

/**
 * Tab clicks emit ModeRequested events into the runtime EventBuffer. The DOM
 * styling (active class on tab + panel) is updated immediately for responsive
 * feel; the SM transitions on the next tick.
 */
function activate(name: string) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  for (const [k, el] of Object.entries(panels)) {
    el.classList.toggle("active", k === name);
  }
}

const url = new URL(location.href);
const scenarioName = url.searchParams.get("scenario");

const worldOpts = {
  hudEl: document.getElementById("hud") as HTMLElement,
  hintEl: document.getElementById("hint") as HTMLElement,
  panelEl: panels.world,
  builderPanelEl: panels.builder,
  profileEditorEl: document.getElementById("profile-editor") as HTMLElement,
};

const world = scenarioName
  ? startScenarioWorld(worldOpts, scenarioName)
  : startWorld(worldOpts);

tabs.forEach((t) =>
  t.addEventListener("click", () => {
    const name = t.dataset.tab!;
    activate(name);
    world.requestMode(name === "builder" ? "builder" : "world");
  }),
);
