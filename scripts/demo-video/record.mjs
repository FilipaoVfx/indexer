#!/usr/bin/env node
/**
 * record.mjs
 *
 * Graba cada escena del storyboard como un clip .webm usando Playwright.
 * Asume que `npm run dev` de web-astro ya esta corriendo en meta.baseUrl.
 *
 * Uso:
 *   node record.mjs                       -> graba todas las escenas
 *   node record.mjs --only 04_hybrid_search  -> graba solo una escena
 *   node record.mjs --baseUrl http://localhost:4322
 *   node record.mjs --headed              -> lanzar browser con ventana visible
 *
 * Salida: scripts/demo-video/clips/<scene.id>.webm
 */

import { chromium } from "playwright";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORYBOARD = path.join(__dirname, "storyboard.json");
const CLIPS_DIR = path.join(__dirname, "clips");

function parseArgs(argv) {
  const args = { only: null, baseUrl: null, headed: false, slowMo: 0 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") args.only = argv[++i];
    else if (a === "--baseUrl") args.baseUrl = argv[++i];
    else if (a === "--headed") args.headed = true;
    else if (a === "--slowMo") args.slowMo = Number(argv[++i]);
  }
  return args;
}

async function loadStoryboard() {
  const raw = await fs.readFile(STORYBOARD, "utf8");
  return JSON.parse(raw);
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function sceneClipPath(sceneId) {
  return path.join(CLIPS_DIR, `${sceneId}.webm`);
}

async function runActions(page, scene, baseUrl) {
  const actions = scene.actions || [];
  for (const action of actions) {
    try {
      await runOneAction(page, action, baseUrl);
    } catch (err) {
      // Lo reportamos pero no abortamos: algunas acciones son best-effort
      // (ej. botones que no siempre estan presentes segun la data real).
      console.warn(`  [scene ${scene.id}] action failed:`, action.type, err.message);
    }
  }
}

async function runOneAction(page, action, baseUrl) {
  switch (action.type) {
    case "wait":
      await page.waitForTimeout(action.ms ?? 500);
      return;

    case "goto": {
      const target = action.path.startsWith("http")
        ? action.path
        : baseUrl.replace(/\/$/, "") + action.path;
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: 15000 });
      return;
    }

    case "scrollBy":
      await page.evaluate(
        ({ y, ms }) => {
          return new Promise((resolve) => {
            const start = performance.now();
            const startY = window.scrollY;
            const step = (now) => {
              const t = Math.min(1, (now - start) / ms);
              window.scrollTo(0, startY + y * t);
              if (t < 1) requestAnimationFrame(step);
              else resolve();
            };
            requestAnimationFrame(step);
          });
        },
        { y: action.y ?? 400, ms: action.ms ?? 1000 }
      );
      return;

    case "scrollIntoView": {
      const loc = page.locator(action.selector).first();
      if ((await loc.count()) > 0) {
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
      }
      return;
    }

    case "ensureMode": {
      // Los botones de modo tienen label "Hibrida" u "Objetivo".
      const label = action.mode === "goal" ? "Objetivo" : "Hibrida";
      const btn = page.locator(`button:has-text("${label}")`).first();
      if ((await btn.count()) > 0) {
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(400);
      }
      return;
    }

    case "fillSearch": {
      const input = page
        .locator('input[placeholder="Describe lo que quieres construir..."], input[placeholder="Busca en tu archivo de conocimiento..."]')
        .first();
      await input.click({ timeout: 5000 });
      await input.fill("");
      await input.type(action.text, { delay: 18 });
      return;
    }

    case "fillPlaceholder": {
      const input = page.locator(`input[placeholder*="${action.placeholder}"]`).first();
      await input.click({ timeout: 5000 });
      await input.fill("");
      await input.type(action.text, { delay: 25 });
      return;
    }

    case "press":
      await page.keyboard.press(action.key);
      return;

    case "click":
      await page.locator(action.selector).first().click({ timeout: 5000 });
      return;

    case "clickText":
      await page.getByText(action.text, { exact: false }).first().click({ timeout: 5000 });
      return;

    case "clickNth": {
      const loc = page.locator(action.selector);
      const count = await loc.count();
      if (count > action.index) {
        await loc.nth(action.index).click({ timeout: 5000 });
      }
      return;
    }

    case "hover":
      await page.locator(action.selector).first().hover({ timeout: 5000 });
      return;

    default:
      console.warn("  unknown action:", action.type);
  }
}

async function recordScene(scene, meta, browser, baseUrl) {
  const { width, height } = meta.resolution;
  const clipPath = sceneClipPath(scene.id);
  // Elimina el anterior para que playwright renombre limpio.
  try {
    await fs.rm(clipPath, { force: true });
  } catch { }

  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    recordVideo: { dir: CLIPS_DIR, size: { width, height } },
    colorScheme: "dark",
  });
  const page = await context.newPage();

  // Ir a la URL inicial
  const initialUrl = scene.url.startsWith("http")
    ? scene.url
    : baseUrl.replace(/\/$/, "") + scene.url;

  try {
    await page.goto(initialUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  } catch (err) {
    console.warn(`  [scene ${scene.id}] initial goto failed:`, err.message);
  }

  await page.waitForTimeout(500);

  // Si la escena declara un mock especial, aplicamos un overlay HTML simulando
  // la extension (no tenemos control real del navegador Chromium del usuario).
  if (scene.mock === "extension_scrape") {
    await injectExtensionMock(page);
  }

  const started = Date.now();
  await runActions(page, scene, baseUrl);

  // Rellena el tiempo restante hasta durationSec
  const elapsed = Date.now() - started;
  const remaining = scene.durationSec * 1000 - elapsed;
  if (remaining > 0) await page.waitForTimeout(remaining);

  const video = page.video();
  await page.close();
  await context.close();

  if (video) {
    const tmpPath = await video.path();
    await fs.rename(tmpPath, clipPath);
    console.log(`  [scene ${scene.id}] -> ${path.relative(process.cwd(), clipPath)}`);
  }
}

async function injectExtensionMock(page) {
  await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.style.cssText = [
      "position:fixed",
      "top:16px",
      "right:16px",
      "z-index:2147483647",
      "width:320px",
      "border:2px solid #22d3ee",
      "background:#0b0f14",
      "color:#e2e8f0",
      "font-family:JetBrains Mono, Menlo, monospace",
      "font-size:12px",
      "box-shadow:8px 8px 0 rgba(168,85,247,0.9)",
      "padding:14px 16px",
      "border-radius:6px",
    ].join(";");
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <div style="width:10px;height:10px;border-radius:50%;background:#22d3ee;"></div>
        <strong style="color:#22d3ee;letter-spacing:0.08em;">indexbook :: ext</strong>
      </div>
      <div style="color:#94a3b8;margin-bottom:10px;">Scrape all bookmarks</div>
      <div id="ext-progress" style="height:6px;background:#111827;border:1px solid #334155;overflow:hidden;">
        <div id="ext-bar" style="height:100%;width:0%;background:#22d3ee;"></div>
      </div>
      <pre id="ext-log" style="margin-top:10px;color:#a78bfa;white-space:pre-wrap;min-height:70px;"></pre>
    `;
    document.body.appendChild(wrap);

    const bar = wrap.querySelector("#ext-bar");
    const log = wrap.querySelector("#ext-log");
    const lines = [
      "> auth.ok",
      "> listing bookmarks...",
      "> batch 1/4 (80 items)",
      "> batch 2/4 (80 items)",
      "> dedup + normalize urls",
      "> batch 3/4 (80 items)",
      "> batch 4/4 (80 items)",
      "> ingested: 320",
    ];
    let i = 0;
    const iv = setInterval(() => {
      if (i >= lines.length) return clearInterval(iv);
      log.textContent += lines[i] + "\n";
      bar.style.width = `${((i + 1) / lines.length) * 100}%`;
      i++;
    }, 650);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const storyboard = await loadStoryboard();
  const baseUrl = args.baseUrl || storyboard.meta.baseUrl || "http://localhost:4323/indexer";

  await ensureDir(CLIPS_DIR);

  const scenes = storyboard.scenes.filter((s) => (args.only ? s.id === args.only : true));
  if (scenes.length === 0) {
    console.error("No scenes matched", args.only);
    process.exit(1);
  }

  console.log(`[record] baseUrl=${baseUrl}, scenes=${scenes.length}, headed=${args.headed}`);

  const browser = await chromium.launch({
    headless: !args.headed,
    slowMo: args.slowMo || 0,
  });

  try {
    for (const scene of scenes) {
      console.log(`\n[scene ${scene.id}] ${scene.label} (${scene.durationSec}s)`);
      await recordScene(scene, storyboard.meta, browser, baseUrl);
    }
  } finally {
    await browser.close();
  }

  console.log("\n[record] done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
