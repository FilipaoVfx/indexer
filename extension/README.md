# Extension MVP

## Archivos

- `manifest.json`: configuracion MV3.
- `content.js`: scraping + scroll infinito + batch builder.
- `background.js`: cola persistente de ingesta + envio a backend.
- `popup.html` / `popup.js`: UI para ejecutar sync y ver estado.

## Flujo de ingesta

1. Popup envia `START_SYNC`.
2. Content scrapea bookmarks y genera lotes.
3. Background encola lotes en `chrome.storage.local`.
4. Background envia lotes al backend con reintentos.
5. Popup recibe eventos de progreso.

## Carga local

1. Abrir `chrome://extensions`.
2. Activar `Developer mode`.
3. Click en `Load unpacked`.
4. Seleccionar carpeta `extension/`.