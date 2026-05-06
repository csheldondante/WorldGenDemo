import { startWorld } from "./app/world";
import { startBuilder } from "./app/builder";

const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const panels: Record<string, HTMLElement> = {
  world: document.getElementById("panel-world")!,
  builder: document.getElementById("panel-builder")!,
};

function activate(name: string) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  for (const [k, el] of Object.entries(panels)) {
    el.classList.toggle("active", k === name);
  }
}

tabs.forEach((t) => t.addEventListener("click", () => activate(t.dataset.tab!)));

void startWorld({
  hudEl: document.getElementById("hud") as HTMLElement,
  hintEl: document.getElementById("hint") as HTMLElement,
  panelEl: panels.world,
});

startBuilder({
  fileInput: document.getElementById("builder-file") as HTMLInputElement,
  nameInput: document.getElementById("builder-name") as HTMLInputElement,
  tileInput: document.getElementById("builder-tile") as HTMLInputElement,
  preview: document.getElementById("builder-preview") as HTMLCanvasElement,
  summaryEl: document.getElementById("builder-summary") as HTMLElement,
  tableWrap: document.getElementById("builder-table-wrap") as HTMLElement,
  output: document.getElementById("builder-output") as HTMLTextAreaElement,
  generateBtn: document.getElementById("builder-generate") as HTMLButtonElement,
  downloadBtn: document.getElementById("builder-download") as HTMLButtonElement,
  downloadPngBtn: document.getElementById("builder-download-png") as HTMLButtonElement,
});
