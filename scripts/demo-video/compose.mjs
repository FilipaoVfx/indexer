#!/usr/bin/env node
/**
 * compose.mjs
 *
 * Toma los .webm de clips/ y compone un .mp4 final con:
 *   - normalizacion a meta.resolution @ meta.fps
 *   - subtitulo inferior (drawtext) por escena
 *   - crossfades entre clips (xfade)
 *   - mezcla opcional de audio/voiceover.mp3 + audio/music.mp3 (con ducking)
 *
 * Requiere: ffmpeg en PATH.
 *
 * Uso:
 *   node compose.mjs
 *   node compose.mjs --out output/mi-demo.mp4
 *   node compose.mjs --noTransitions
 *   node compose.mjs --noCaption
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORYBOARD = path.join(__dirname, "storyboard.json");
const CLIPS_DIR = path.join(__dirname, "clips");
const OUT_DIR = path.join(__dirname, "output");
const INTERMEDIATE_DIR = path.join(__dirname, "clips", "_normalized");

function parseArgs(argv) {
  const args = {
    out: path.join(OUT_DIR, "indexbook-demo.mp4"),
    noTransitions: false,
    noCaption: false,
    noAudio: false,
    preset: "medium",
    crf: 20,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--noTransitions") args.noTransitions = true;
    else if (a === "--noCaption") args.noCaption = true;
    else if (a === "--noAudio") args.noAudio = true;
    else if (a === "--preset") args.preset = argv[++i];
    else if (a === "--crf") args.crf = Number(argv[++i]);
  }
  return args;
}

function run(cmd, cmdArgs, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function checkFfmpeg() {
  try {
    await new Promise((resolve, reject) => {
      const c = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
      c.on("error", reject);
      c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("ffmpeg failed"))));
    });
  } catch {
    console.error(
      "ffmpeg no esta instalado o no esta en PATH.\n" +
        "Windows:  winget install Gyan.FFmpeg  (o choco install ffmpeg)\n" +
        "macOS:    brew install ffmpeg\n" +
        "Linux:    sudo apt-get install ffmpeg"
    );
    process.exit(1);
  }
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escapa un string para uso seguro dentro del filtro drawtext de ffmpeg.
 * Fuente: https://ffmpeg.org/ffmpeg-filters.html#drawtext-1 (caracteres especiales).
 */
function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/,/g, "\\,");
}

/**
 * Normaliza un clip .webm -> mp4 con:
 *  - resolucion fija, fps fijo
 *  - drawtext con la caption (si la hay)
 *  - duracion exacta (trim o pad al length declarado)
 *  - audio silencio mono 48k (para poder concatenar despues)
 */
async function normalizeScene(scene, meta, overlay, args) {
  const src = path.join(CLIPS_DIR, `${scene.id}.webm`);
  const dst = path.join(INTERMEDIATE_DIR, `${scene.id}.mp4`);
  if (!(await exists(src))) {
    throw new Error(`Falta el clip ${src}. Ejecuta primero: node record.mjs`);
  }

  const { width, height } = meta.resolution;
  const fps = meta.fps;
  const dur = scene.durationSec;

  const vf = [];
  vf.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
  vf.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`);
  vf.push(`fps=${fps}`);
  vf.push(`setsar=1`);

  if (overlay?.enable && !args.noCaption && scene.caption) {
    const text = escapeDrawtext(scene.caption);
    const fontFileExpr = overlay.fontFile ? `fontfile='${overlay.fontFile.replace(/\\/g, "/")}':` : "";
    const draw = [
      `drawtext=${fontFileExpr}text='${text}'`,
      `fontcolor=${overlay.fontColor || "white"}`,
      `fontsize=${overlay.fontSize || 28}`,
      `box=1`,
      `boxcolor=${overlay.boxColor || "black@0.55"}`,
      `boxborderw=${overlay.boxBorderW || 14}`,
      `x=${overlay.position?.x || "(w-text_w)/2"}`,
      `y=${overlay.position?.y || "h-120"}`,
      `enable='between(t,0.3,${dur - 0.2})'`,
    ].join(":");
    vf.push(draw);
  }

  // Fades in/out
  vf.push(`fade=t=in:st=0:d=0.25`);
  vf.push(`fade=t=out:st=${Math.max(0, dur - 0.35)}:d=0.35`);

  const cmd = [
    "-y",
    "-i",
    src,
    "-t",
    String(dur),
    "-vf",
    vf.join(","),
    // audio silencio para alinear con mux final
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-shortest",
    "-c:v",
    "libx264",
    "-preset",
    args.preset,
    "-crf",
    String(args.crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    dst,
  ];

  console.log(`  [normalize] ${scene.id} -> ${path.basename(dst)}`);
  await run("ffmpeg", cmd);
  return dst;
}

/**
 * Concatena clips usando concat demuxer (simple, sin crossfade).
 */
async function concatDemuxer(files, outFile) {
  const listFile = path.join(INTERMEDIATE_DIR, "_concat.txt");
  const body = files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  await fs.writeFile(listFile, body, "utf8");
  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    outFile,
  ]);
}

/**
 * Concatena con xfade: necesita un filter_complex que encadena N-1 xfade.
 * Para videos cortos (<120s en total) esto es trivial; para videos largos
 * el demuxer simple suele ser suficiente.
 */
async function concatWithXfade(files, scenes, meta, outFile, transitions) {
  const xdur = transitions.durationSec || 0.5;
  const fps = meta.fps;
  const sr = 48000;

  const inputs = [];
  files.forEach((f) => {
    inputs.push("-i", f);
  });

  // Construimos el filter_complex
  const vFilters = [];
  const aFilters = [];

  // offsets acumulados para el xfade
  let offset = 0;
  let prevV = "0:v";
  let prevA = "0:a";
  for (let i = 1; i < files.length; i++) {
    const sceneDurPrev = scenes[i - 1].durationSec;
    offset += sceneDurPrev - xdur;

    const outV = `v${i}`;
    const outA = `a${i}`;

    vFilters.push(
      `[${prevV}][${i}:v]xfade=transition=${transitions.variant || "fade"}:duration=${xdur}:offset=${offset.toFixed(
        3
      )}[${outV}]`
    );
    aFilters.push(`[${prevA}][${i}:a]acrossfade=d=${xdur}[${outA}]`);

    prevV = outV;
    prevA = outA;
  }

  const filterComplex = [...vFilters, ...aFilters].join(";");

  const cmd = [
    "-y",
    ...inputs,
    "-filter_complex",
    filterComplex,
    "-map",
    `[${prevV}]`,
    "-map",
    `[${prevA}]`,
    "-r",
    String(fps),
    "-ar",
    String(sr),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    outFile,
  ];

  await run("ffmpeg", cmd);
}

/**
 * Mezcla audio: voiceover (primario) + music (background con ducking).
 * Si solo existe uno de los dos, solo usa ese.
 * Si no existe ninguno, retorna null (nos quedamos con el silencio del video base).
 */
async function mixAudio(meta, outVideoPath, args) {
  if (args.noAudio) return null;
  const audioCfg = { ...(meta.audio || {}) };
  const voPath = audioCfg.voiceoverFile
    ? path.join(__dirname, audioCfg.voiceoverFile)
    : null;
  const musicPath = audioCfg.musicFile ? path.join(__dirname, audioCfg.musicFile) : null;

  const hasVo = voPath && (await exists(voPath));
  const hasMusic = musicPath && (await exists(musicPath));

  if (!hasVo && !hasMusic) {
    console.log("  [audio] ni voiceover ni music encontrados, se omite mux.");
    return null;
  }

  const mixedPath = path.join(INTERMEDIATE_DIR, "_mixed.m4a");
  const inputs = [];
  const filters = [];

  if (hasVo) inputs.push("-i", voPath);
  if (hasMusic) inputs.push("-i", musicPath);

  if (hasVo && hasMusic) {
    const duck = audioCfg.musicDuckDb ?? -18;
    // music volume con ducking via sidechaincompress sobre voice
    filters.push(
      `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[voice]`,
      `[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${duck}dB[music_low]`,
      `[voice][music_low]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`
    );
  } else if (hasVo) {
    filters.push(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
  } else {
    filters.push(`[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);
  }

  await run("ffmpeg", [
    "-y",
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[aout]",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    mixedPath,
  ]);
  return mixedPath;
}

async function muxAudioIntoVideo(videoPath, audioPath, outPath) {
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    outPath,
  ]);
}

async function main() {
  const args = parseArgs(process.argv);
  await checkFfmpeg();

  const storyboard = JSON.parse(await fs.readFile(STORYBOARD, "utf8"));
  const { meta, scenes, transitions, overlay } = storyboard;

  await fs.mkdir(INTERMEDIATE_DIR, { recursive: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log(`[compose] normalizando ${scenes.length} escenas a ${meta.resolution.width}x${meta.resolution.height}@${meta.fps}fps`);
  const normalized = [];
  for (const scene of scenes) {
    normalized.push(await normalizeScene(scene, meta, overlay, args));
  }

  const concatOut = path.join(INTERMEDIATE_DIR, "_concat.mp4");
  if (args.noTransitions || scenes.length < 2) {
    console.log("[compose] concat simple (sin transiciones)");
    await concatDemuxer(normalized, concatOut);
  } else {
    console.log(`[compose] concat con xfade (${transitions?.variant || "fade"}, ${transitions?.durationSec || 0.5}s)`);
    await concatWithXfade(normalized, scenes, meta, concatOut, transitions || {});
  }

  const mixed = await mixAudio(meta, concatOut, args);
  if (mixed) {
    console.log("[compose] muxing voiceover + music -> video final");
    await muxAudioIntoVideo(concatOut, mixed, args.out);
  } else {
    // Copia sin tocar
    await fs.copyFile(concatOut, args.out);
  }

  console.log(`\n[compose] OK -> ${path.relative(process.cwd(), args.out)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
