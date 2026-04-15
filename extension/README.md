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

## Produccion

1. Actualizar `DEFAULT_API_BASE_URL` en `background.js` con tu backend HTTPS.
2. Verificar `host_permissions` en `manifest.json` para incluir tu dominio backend.
3. Empaquetar zip con:
   - `powershell -ExecutionPolicy Bypass -File .\scripts\package-extension.ps1`
4. Publicar `dist/x-bookmarks-extension.zip` en Chrome Web Store.
