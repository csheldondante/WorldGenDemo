// Run with: npm run smoke
// Boots vite dev server on a fixed port, navigates a headless Chromium page,
// captures console + network + screenshot + window.__runtimeDebug, then exits.
//
// Output files (smoke-out/):
//   console.log    — every console.*, pageerror, requestfailed event
//   network.log    — every HTTP response, status code + URL
//   page.png       — full-page screenshot
//   state.json     — window.__runtimeDebug() snapshot from world.ts

import { chromium, type ConsoleMessage } from "playwright";
import spawn from "cross-spawn";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = 5180;
const MAP_PARAM = process.env.MAP ? `?map=${encodeURIComponent(process.env.MAP)}` : "";
const URL = `http://127.0.0.1:${PORT}/${MAP_PARAM}`;

/**
 * Windows-safe process tree kill. cross-spawn returns a wrapper around the
 * shell that started vite; killing the wrapper does NOT kill the child node
 * process holding the port. taskkill /T /F kills the whole tree.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // best effort
    }
  } else {
    try { process.kill(-pid, "SIGTERM"); } catch { /* */ }
    try { process.kill(pid, "SIGTERM"); } catch { /* */ }
  }
}
const DWELL_MS = 4000;
const READY_TIMEOUT_MS = 30_000;

interface ChildWithIO {
  pid?: number;
  kill: (signal?: NodeJS.Signals | number) => boolean;
  stdout?: { on: (event: "data", cb: (chunk: Buffer) => void) => void } | null;
  stderr?: { on: (event: "data", cb: (chunk: Buffer) => void) => void } | null;
}

function killWhoeverHasPort(port: number): void {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const pids = new Set<string>();
    for (const line of out.split("\n")) {
      const m = line.match(/LISTENING\s+(\d+)/);
      if (m) pids.add(m[1]);
    }
    for (const pid of pids) {
      try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" }); } catch { /* */ }
    }
  } catch { /* nothing on port */ }
}

async function main(): Promise<void> {
  const outDir = resolve("smoke-out");
  mkdirSync(outDir, { recursive: true });

  // 0. Make sure no stale vite is holding the port from a prior failed run.
  killWhoeverHasPort(PORT);

  // 1. Spawn vite dev server.
  console.log(`[smoke] starting vite on :${PORT}…`);
  const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as ChildWithIO;

  // Capture vite output so we can see the "Local:" line and surface errors.
  let viteOut = "";
  let viteReady = false;
  const readyPromise = new Promise<void>((res, rej) => {
    const done = (ok: boolean, err?: string) => {
      if (viteReady) return;
      viteReady = true;
      if (ok) res();
      else rej(new Error(err ?? "vite not ready"));
    };
    const timer = setTimeout(() => done(false, `vite did not become ready within ${READY_TIMEOUT_MS}ms`), READY_TIMEOUT_MS);
    vite.stdout?.on("data", (chunk) => {
      const s = chunk.toString();
      viteOut += s;
      // Vite color-codes "Local:" so the literal text is split by ANSI escapes.
      // Strip ANSI before substring matching.
      const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
      if (plain.includes(`127.0.0.1:${PORT}`) || plain.includes(`localhost:${PORT}`) || plain.includes("ready in")) {
        clearTimeout(timer);
        done(true);
      }
    });
    vite.stderr?.on("data", (chunk) => {
      viteOut += chunk.toString();
    });
  });

  try {
    await readyPromise;
  } catch (err) {
    writeFileSync(resolve(outDir, "vite.log"), viteOut);
    console.error("[smoke] vite failed:", (err as Error).message);
    killTree(vite.pid);
    process.exitCode = 1;
    return;
  }

  // 2. Launch browser + capture everything.
  const consoleLines: string[] = [];
  const networkLines: string[] = [];

  const fmtConsole = (m: ConsoleMessage): string => `[${m.type()}] ${m.text()}`;

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();

    page.on("console", (m) => consoleLines.push(fmtConsole(m)));
    page.on("pageerror", (e) => consoleLines.push(`[pageerror] ${e.message}\n${e.stack ?? ""}`));
    page.on("requestfailed", (r) => {
      const f = r.failure();
      consoleLines.push(`[netfail] ${r.method()} ${r.url()} :: ${f?.errorText ?? "unknown"}`);
    });
    page.on("response", (r) => networkLines.push(`${r.status()} ${r.request().method()} ${r.url()}`));

    console.log(`[smoke] navigating to ${URL}…`);
    await page.goto(URL, { waitUntil: "load", timeout: 15_000 });
    console.log(`[smoke] dwelling ${DWELL_MS}ms…`);
    await page.waitForTimeout(DWELL_MS);

    await page.screenshot({ path: resolve(outDir, "page.png"), fullPage: true });

    // Optional: MODE=builder runs a builder-tab round-trip and captures a second screenshot.
    if (process.env.MODE === "builder") {
      console.log("[smoke] clicking Scene Builder tab…");
      await page.click('button[data-tab="builder"]');
      await page.waitForTimeout(2000); // let bootstrap + thumbnails resolve
      await page.screenshot({ path: resolve(outDir, "page-builder.png"), fullPage: true });

      console.log("[smoke] testing flood-fill + send-to-world…");
      // Switch to fill tool
      await page.click("#tool-fill");
      await page.waitForTimeout(100);
      // Click somewhere on the canvas to fill
      const canvasBox = await page.locator("#paint-canvas").boundingBox();
      if (canvasBox) {
        await page.mouse.click(canvasBox.x + canvasBox.width * 0.3, canvasBox.y + canvasBox.height * 0.3);
        await page.waitForTimeout(200);
      }
      // Send to world
      await page.click("#send-to-world");
      await page.waitForTimeout(2500);
      await page.screenshot({ path: resolve(outDir, "page-after-send.png"), fullPage: true });
    }

    const dbg = await page.evaluate(() => {
      const fn = (window as unknown as { __runtimeDebug?: () => unknown }).__runtimeDebug;
      return fn ? fn() : null;
    });
    writeFileSync(resolve(outDir, "console.log"), consoleLines.join("\n"));
    writeFileSync(resolve(outDir, "network.log"), networkLines.join("\n"));
    writeFileSync(resolve(outDir, "state.json"), JSON.stringify(dbg, null, 2));
    console.log(
      `[smoke] wrote: ${consoleLines.length} console / ${networkLines.length} requests / state${dbg ? "" : " (null!)"}`,
    );
  } finally {
    await browser.close();
    killTree(vite.pid);
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error("[smoke] failed:", err);
    process.exit(1);
  },
);
