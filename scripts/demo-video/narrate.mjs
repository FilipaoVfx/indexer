#!/usr/bin/env node
/**
 * narrate.mjs
 *
 * Genera archivos de narracion listos para usar con el TTS de tu eleccion.
 *
 *  1. Escribe `narration/<scene.id>.txt` con el voiceover de cada escena.
 *  2. Escribe `narration/_full.txt` con el guion concatenado (un parrafo por escena).
 *  3. Si encuentra un TTS local soportado intenta sintetizar audio de prueba:
 *       - macOS     : `say -v Paulina -o narration/<id>.aiff "texto"`
 *       - Linux     : `espeak-ng -v es -w narration/<id>.wav "texto"`
 *       - PowerShell: Windows SAPI via System.Speech (sintesis simple, voz del SO)
 *     Es calidad "borrador" - para produccion usa ElevenLabs, Azure TTS, o
 *     el comando `/generate-voiceover` del claude-code-video-toolkit.
 *
 * Uso:
 *   node narrate.mjs
 *   node narrate.mjs --synth   -> intenta sintetizar audio local
 *   node narrate.mjs --lang es
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORYBOARD = path.join(__dirname, "storyboard.json");
const NARR_DIR = path.join(__dirname, "narration");

function parseArgs(argv) {
  const args = { synth: false, lang: "es" };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--synth") args.synth = true;
    else if (a === "--lang") args.lang = argv[++i];
  }
  return args;
}

function runCapture(cmd, cmdArgs) {
  return new Promise((resolve) => {
    const c = spawn(cmd, cmdArgs, { stdio: "ignore" });
    c.on("error", () => resolve(false));
    c.on("exit", (code) => resolve(code === 0));
  });
}

async function hasCommand(cmd) {
  // which / where
  const isWin = process.platform === "win32";
  return runCapture(isWin ? "where" : "which", [cmd]);
}

async function trySynthOne(scene, args) {
  const text = scene.voiceover;
  if (!text) return null;
  const baseOut = path.join(NARR_DIR, scene.id);

  if (process.platform === "darwin" && (await hasCommand("say"))) {
    const out = `${baseOut}.aiff`;
    const ok = await runCapture("say", ["-v", "Paulina", "-o", out, text]);
    return ok ? out : null;
  }

  if (process.platform === "linux" && (await hasCommand("espeak-ng"))) {
    const out = `${baseOut}.wav`;
    const ok = await runCapture("espeak-ng", ["-v", args.lang, "-s", "170", "-w", out, text]);
    return ok ? out : null;
  }

  if (process.platform === "win32") {
    const out = `${baseOut}.wav`;
    const ps = [
      "Add-Type -AssemblyName System.Speech;",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
      `$s.SetOutputToWaveFile('${out.replace(/\\/g, "/")}');`,
      `$s.Speak('${text.replace(/'/g, "''")}');`,
      "$s.Dispose();",
    ].join(" ");
    const ok = await runCapture("powershell.exe", ["-NoProfile", "-Command", ps]);
    return ok ? out : null;
  }

  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  const storyboard = JSON.parse(await fs.readFile(STORYBOARD, "utf8"));

  await fs.mkdir(NARR_DIR, { recursive: true });

  const fullLines = [];
  for (const scene of storyboard.scenes) {
    const text = scene.voiceover || "";
    await fs.writeFile(path.join(NARR_DIR, `${scene.id}.txt`), text + "\n", "utf8");
    fullLines.push(`# ${scene.id} (${scene.durationSec}s) - ${scene.label}`);
    fullLines.push(text);
    fullLines.push("");
  }
  await fs.writeFile(path.join(NARR_DIR, "_full.txt"), fullLines.join("\n"), "utf8");
  console.log(`[narrate] ${storyboard.scenes.length} archivos escritos en narration/`);

  if (!args.synth) {
    console.log("\nPara sintetizar audio:");
    console.log("  node narrate.mjs --synth        (usa TTS del sistema, calidad borrador)");
    console.log("  o bien, usa un servicio externo (ElevenLabs / Azure / OpenAI TTS)");
    console.log("  y coloca el resultado final en audio/voiceover.mp3");
    return;
  }

  console.log(`\n[narrate] intentando sintesis local (${process.platform})...`);
  for (const scene of storyboard.scenes) {
    const out = await trySynthOne(scene, args);
    if (out) console.log(`  ok  ${scene.id} -> ${path.relative(process.cwd(), out)}`);
    else console.log(`  --  ${scene.id} (no se pudo sintetizar localmente)`);
  }

  console.log("\n[narrate] nota: para el mezclado final necesitas un unico");
  console.log("         audio/voiceover.mp3 de ~90s alineado al storyboard.");
  console.log("         Puedes unir los fragmentos con:");
  console.log("           ffmpeg -i \"concat:narration/01_cold_open.wav|narration/02_...wav\" \\\n                  -acodec libmp3lame audio/voiceover.mp3");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
