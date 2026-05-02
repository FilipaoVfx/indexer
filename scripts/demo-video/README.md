# Pipeline del demo promocional de Indexbook

Este directorio contiene todo lo necesario para producir, desde tu maquina, el
video promocional descrito en [`docs/demo-promocional-indexbook.md`](../../docs/demo-promocional-indexbook.md).

La idea es que Claude (o tu) solo tengas que correr tres comandos:

```bash
cd scripts/demo-video
npm install
npm run record     # graba cada escena con Playwright
npm run narrate    # genera el guion por escena (opcional: sintesis local)
npm run compose    # ensambla el .mp4 final con ffmpeg
```

El archivo final sale en `output/indexbook-demo.mp4`.

---

## 1. Requisitos

- Node.js 18+ (probado con 22).
- [FFmpeg](https://ffmpeg.org/download.html) en `PATH`.
  - Windows: `winget install Gyan.FFmpeg` o `choco install ffmpeg`.
  - macOS: `brew install ffmpeg`.
  - Linux: `sudo apt-get install ffmpeg`.
- La app de Indexbook corriendo localmente (por defecto `http://localhost:4321`).
  Asegurate de que `web-astro` apunta al backend que tenga datos reales
  (Render o local); de lo contrario las escenas saldran vacias.

Instalacion:

```bash
cd scripts/demo-video
npm install         # instala playwright + browsers
```

> `postinstall` baja Chromium de Playwright (~170MB). Si ya lo tienes instalado
> globalmente puedes saltarlo con `npm install --ignore-scripts` y correr
> `npx playwright install chromium` manualmente.

---

## 2. Configuracion del dataset (antes de grabar)

Lee la seccion `## Setup antes de grabar` de
[`docs/demo-promocional-indexbook.md`](../../docs/demo-promocional-indexbook.md#setup-antes-de-grabar).
En corto:

- Bookmarks ya sincronizados.
- Una query hibrida que devuelva cards con multimedia y repos detectados.
- Una query en modo `Objetivo` que produzca al menos 4 pasos en el pipeline.
- Un repo con README cacheado para la escena de `/readmes`.
- Opcional: aplicar `backend/sql/010_repo_classifier.sql` y correr el backfill
  si quieres mostrar la clasificacion canonica.

Las queries exactas que usa este pipeline estan en [`storyboard.json`](./storyboard.json),
bajo el campo `actions[].text` de cada escena. Si tu dataset prefiere otros
terminos, edita el JSON y vuelve a correr `npm run record`.

---

## 3. Grabacion (Playwright)

```bash
# todas las escenas
npm run record

# solo una escena, util para iterar
npm run record:one -- 07_pipeline_view

# con ventana visible (por defecto corre headless)
npm run record:headed

# apuntando a otra URL de dev
node record.mjs --baseUrl http://localhost:4322
```

Cada escena produce `clips/<scene.id>.webm`. Si una accion falla (por ejemplo
`clickText: "ver menciones"` porque la card en turno no tiene menciones) el
script continua con la siguiente, no aborta. Revisa el log si un clip sale
mudo o en blanco.

### Escena especial: la extension

La escena `02_extension_scrape` no puede grabarse "de verdad" en Playwright
porque la extension corre dentro de `x.com`, fuera de nuestro dominio. Por eso
este script inyecta un overlay HTML (terminal cian/morado con barra de
progreso y log) que simula el flujo de scraping. Si tienes screen recordings
reales de la extension, reemplaza el archivo `clips/02_extension_scrape.webm`
antes de correr `compose`.

---

## 4. Narracion y voiceover

```bash
npm run narrate              # solo escribe los .txt por escena
npm run narrate:synth        # intenta TTS local (macOS say / Linux espeak / Windows SAPI)
```

Para produccion, carga `narration/_full.txt` en tu TTS preferido:

- **ElevenLabs** (voz multilenguaje, recomendada para espanol).
- **Azure Speech** (neural, buenas voces `es-ES-ElviraNeural`, `es-MX-DaliaNeural`).
- **OpenAI TTS** (`tts-1`, voz `nova` o `alloy`).
- [`/generate-voiceover`](https://github.com/digitalsamba/claude-code-video-toolkit)
  del claude-code-video-toolkit si ya lo tienes instalado.

Deja el audio final como `audio/voiceover.mp3` (mono o estereo, 48kHz ideal,
~90 segundos). Opcionalmente agrega `audio/music.mp3` para una pista de fondo
(se baja automaticamente en `-18dB` mientras hay voz).

---

## 5. Composicion (ffmpeg)

```bash
npm run compose                   # default: 1600x900 @ 30fps, crossfades, h264 crf 20
npm run compose:fast              # render rapido para revisar (crf 23, preset veryfast)
node compose.mjs --noTransitions  # cortes duros (util si Playwright da clips raros)
node compose.mjs --noCaption      # sin subtitulos drawtext
node compose.mjs --out output/indexbook-demo-45s.mp4
```

Salida: `output/indexbook-demo.mp4`.

Que hace `compose.mjs`, paso por paso:

1. **Normaliza** cada `clips/<id>.webm` a `1600x900@30fps`, padea con negro si
   el video original tiene otra proporcion, agrega fade-in/out de 0.25/0.35s y
   dibuja la `caption` de la escena como lower-third (drawtext, caja negra
   semitransparente).
2. **Concatena** con `xfade` (crossfade de 0.5s por default).
3. **Mezcla audio**: si existen `audio/voiceover.mp3` y/o `audio/music.mp3`,
   los combina (musica a -18dB bajo voz, amix). Si no, el video sale mudo.
4. **Muxea** el audio al video final y escribe `output/indexbook-demo.mp4`
   con `faststart` para streaming.

---

## 6. Version corta de 45 segundos

Edita `storyboard.json` y reduce la lista de escenas a:

```
02_extension_scrape, 04_hybrid_search, 05_mentioned_repos,
06_goal_input, 07_pipeline_view, 11_readmes, 12_closing
```

Con duraciones ~5-7s cada una terminas cerca de los 45s. Luego:

```bash
node record.mjs
node compose.mjs --out output/indexbook-demo-45s.mp4
```

---

## 7. Integracion opcional con toolkits externos

### `claude-code-video-toolkit` ([repo](https://github.com/digitalsamba/claude-code-video-toolkit))

Es un plugin completo para Claude Code con skills `/video`, `/record-demo`,
`/generate-voiceover`, `/design`. Si lo tienes instalado puedes:

- Usar `/record-demo` en lugar de `record.mjs` (captura navegador con
  anotaciones y zoom automatico).
- Usar `/generate-voiceover` para sintetizar `audio/voiceover.mp3` con voces
  profesionales.
- Terminar la composicion con Remotion (template `product-demo`) en vez de
  ffmpeg, si quieres motion graphics mas elaborados.

Este pipeline local sigue siendo util como fallback sin dependencias cloud.

### `ff-toolkit` ([repo](https://github.com/inthepond/ff-toolkit))

Wrapper Python de 5 operaciones de ffmpeg (clip, merge, extract-audio,
subtitle, transcode). No implementa `drawtext` ni `xfade`, por eso
`compose.mjs` invoca ffmpeg directamente. Si prefieres la CLI de `ff-toolkit`
para recortar o concatenar:

```bash
pip install ff-toolkit
ffkit merge clips/_normalized/*.mp4 -o output/indexbook-demo.mp4
```

... pero perderias las transiciones y los subtitulos embebidos.

---

## 8. Arbol de archivos resultante

```
scripts/demo-video/
├── storyboard.json         # fuente de la verdad: escenas, duraciones, copy
├── record.mjs              # Playwright -> clips/<id>.webm
├── compose.mjs             # ffmpeg -> output/indexbook-demo.mp4
├── narrate.mjs             # genera narration/*.txt y TTS opcional
├── package.json
├── README.md
├── clips/                  # [gitignored] clips crudos .webm + _normalized/*.mp4
├── narration/              # [gitignored para .wav/.mp3] guion por escena
├── audio/
│   ├── voiceover.mp3       # [gitignored] ponlo aqui
│   └── music.mp3           # [gitignored] opcional
└── output/                 # [gitignored] video final .mp4
```

---

## 9. Troubleshooting

| Sintoma | Causa probable | Remedio |
| --- | --- | --- |
| `ffmpeg: command not found` | FFmpeg no esta en PATH | Ver seccion 1 |
| Clips en blanco | App no esta corriendo | `cd web-astro && npm run dev` |
| Goal mode sin pipeline | Backend no devuelve `steps[]` | Aplica migraciones 008 y 009 en Supabase |
| Modal "Ver repos" no abre | El post en pantalla no tiene repos detectados | Ajusta `actions[].text` en la escena 05 |
| Audio desalineado con video | `audio/voiceover.mp3` no dura ~95s | Re-exporta TTS ajustando `_full.txt` |
| Xfade rompe la pista de audio | Clips muy cortos (<2s) | Aumenta `durationSec` o usa `--noTransitions` |
| `react-flow__node` no encontrado | Render tarda | Aumenta `wait` inicial en escena 07 |

---

## 10. Caminos de mejora

- Exportar resoluciones alternativas (`1080x1920` para shorts verticales).
- Zoom + spotlight automatico sobre cada click (via Remotion o `zoompan`).
- Subtitulos embebidos SRT (generar desde `narration/*.txt` con duraciones).
- Modo "screen recorder real" via `ffmpeg -f gdigrab` (Windows) / `avfoundation`
  (macOS) si se quiere capturar interacciones fuera del navegador.
