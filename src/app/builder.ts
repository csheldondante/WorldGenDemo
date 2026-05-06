import { ALL_TERRAINS, type SceneFile, type SceneLabel } from "../core/types";
import { registerBuiltinAssets } from "../assets/register";
import { AssetCatalog } from "../assets/catalog";

interface UI {
  fileInput: HTMLInputElement;
  nameInput: HTMLInputElement;
  tileInput: HTMLInputElement;
  preview: HTMLCanvasElement;
  summaryEl: HTMLElement;
  tableWrap: HTMLElement;
  output: HTMLTextAreaElement;
  generateBtn: HTMLButtonElement;
  downloadBtn: HTMLButtonElement;
  downloadPngBtn: HTMLButtonElement;
}

interface ColorRow {
  hex: string;
  count: number;
  rgb: [number, number, number];
  /** chosen kind: "ignore" / terrain id / asset id */
  selection: string;
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function snap(v: number): number {
  // Snap to a 16-step grid per channel for tolerant grouping (so "almost-equal" colors merge)
  return Math.round(v / 16) * 16;
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("failed to read image"));
    img.src = URL.createObjectURL(file);
  });
}

function imageToData(img: HTMLImageElement, target: HTMLCanvasElement): ImageData {
  // Cap size to 512 for histogram sanity, keeping aspect ratio.
  const max = 512;
  let w = img.naturalWidth, h = img.naturalHeight;
  if (Math.max(w, h) > max) {
    if (w >= h) { h = Math.round(h * max / w); w = max; }
    else { w = Math.round(w * max / h); h = max; }
  }
  target.width = w;
  target.height = h;
  const ctx = target.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function histogram(data: ImageData): ColorRow[] {
  const map = new Map<string, ColorRow>();
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const r = snap(d[i]);
    const g = snap(d[i + 1]);
    const b = snap(d[i + 2]);
    const hex = rgbToHex(r, g, b);
    let row = map.get(hex);
    if (!row) {
      row = { hex, count: 0, rgb: [r, g, b], selection: "ignore" };
      map.set(hex, row);
    }
    row.count++;
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

function selectionOptions(): { group: string; ids: string[] }[] {
  const assets = AssetCatalog.ids().slice().sort();
  return [
    { group: "ignore", ids: ["ignore"] },
    { group: "terrain", ids: ALL_TERRAINS.slice() },
    { group: "asset", ids: assets },
  ];
}

function renderTable(rows: ColorRow[], wrap: HTMLElement, onChange: () => void) {
  wrap.innerHTML = "";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = `<tr><th></th><th>color</th><th>pixels</th><th>map to</th></tr>`;
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");

    const swatchTd = document.createElement("td");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = row.hex;
    swatchTd.appendChild(sw);
    tr.appendChild(swatchTd);

    const hexTd = document.createElement("td");
    hexTd.textContent = row.hex;
    tr.appendChild(hexTd);

    const countTd = document.createElement("td");
    countTd.textContent = row.count.toLocaleString();
    tr.appendChild(countTd);

    const sel = document.createElement("select");
    for (const group of selectionOptions()) {
      const og = document.createElement("optgroup");
      og.label = group.group;
      for (const id of group.ids) {
        const o = document.createElement("option");
        o.value = group.group === "ignore" ? "ignore" : `${group.group}:${id}`;
        o.textContent = group.group === "ignore" ? "(ignore)" : id;
        if (o.value === row.selection || (row.selection === "ignore" && group.group === "ignore")) {
          o.selected = true;
        }
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.addEventListener("change", () => {
      row.selection = sel.value;
      onChange();
    });

    const selTd = document.createElement("td");
    selTd.appendChild(sel);
    tr.appendChild(selTd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

function buildSceneFromRows(rows: ColorRow[], name: string, tileSize: number): SceneFile {
  const labels: SceneLabel[] = [];
  for (const row of rows) {
    if (!row.selection || row.selection === "ignore") continue;
    const [group, id] = row.selection.split(":");
    if (group === "terrain") {
      labels.push({ color: row.hex, kind: "terrain", terrain: id as any });
    } else if (group === "asset") {
      labels.push({ color: row.hex, kind: "asset", asset: id });
    }
  }
  return { name, tileSize, labels };
}

function autoAssignDefaults(rows: ColorRow[]): void {
  // Naive heuristic: assign biggest unassigned color to plains, second to forest, etc.
  // Keeps the user from staring at a blank table — they can override afterwards.
  const guesses = ["terrain:plains", "terrain:forest", "terrain:desert", "terrain:water", "terrain:canyon_wall", "terrain:path"];
  for (let i = 0; i < rows.length && i < guesses.length; i++) {
    if (rows[i].selection === "ignore") rows[i].selection = guesses[i];
  }
}

function downloadBlob(name: string, mime: string, data: BlobPart) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function startBuilder(ui: UI): void {
  registerBuiltinAssets();

  let rows: ColorRow[] = [];
  let lastImageData: ImageData | null = null;

  function refreshSummary() {
    const used = rows.filter((r) => r.selection !== "ignore");
    ui.summaryEl.innerHTML =
      `<b>${rows.length}</b> distinct colors (snapped to /16 grid)<br>` +
      `${used.length} mapped · ${rows.length - used.length} ignored<br>` +
      (lastImageData ? `${lastImageData.width}×${lastImageData.height} px` : "");
  }

  function regenerate() {
    const tileSize = parseFloat(ui.tileInput.value) || 1.0;
    const scene = buildSceneFromRows(rows, ui.nameInput.value || "my-scene", tileSize);
    ui.output.value = JSON.stringify(scene, null, 2);
  }

  ui.fileInput.addEventListener("change", async () => {
    const file = ui.fileInput.files?.[0];
    if (!file) return;
    const img = await loadImageFromFile(file);
    lastImageData = imageToData(img, ui.preview);
    rows = histogram(lastImageData);
    autoAssignDefaults(rows);
    renderTable(rows, ui.tableWrap, () => { refreshSummary(); regenerate(); });
    refreshSummary();
    regenerate();
  });

  ui.generateBtn.addEventListener("click", () => {
    regenerate();
  });

  ui.downloadBtn.addEventListener("click", () => {
    if (!ui.output.value) regenerate();
    downloadBlob("scene.json", "application/json", ui.output.value);
  });

  ui.downloadPngBtn.addEventListener("click", () => {
    if (!lastImageData) return;
    ui.preview.toBlob((blob) => {
      if (!blob) return;
      downloadBlob("map.png", "image/png", blob);
    }, "image/png");
  });
}
