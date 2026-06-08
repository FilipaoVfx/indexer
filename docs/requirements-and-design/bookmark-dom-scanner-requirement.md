# Feature Requirement — Scanner DOM de Bookmarks para Extensión Indexer

## 1. Nombre del feature

**Bookmark DOM Scanner / Pending Bookmarks Detector**

---

## 2. Objetivo

Permitir que la extensión de Indexer escanee la página de bookmarks de X/Twitter, detecte posts visibles, extraiga su `tweet_id`, compare localmente contra los bookmarks ya guardados en el sistema y permita importar de forma selectiva los posts pendientes.

El feature debe evitar llamadas innecesarias al backend y mantener buena performance incluso con scroll infinito.

---

## 3. Problema

Actualmente la extensión puede capturar bookmarks visibles desde desktop, pero el usuario también puede guardar posts desde móvil u otros contextos.

Como no se usará la API oficial de X, el sistema no puede consultar directamente la lista completa de bookmarks del usuario.

La alternativa es usar la página `/i/bookmarks` como fuente visual y escanear los posts renderizados en el DOM.

---

## 4. Hipótesis técnica

Cada post renderizado en la página de bookmarks contiene al menos un enlace con una estructura similar a:

```txt
/{username}/status/{tweet_id}
```

Ejemplo:

```txt
https://x.com/user/status/1234567890123456789
```

A partir de ese enlace se puede extraer un identificador único del post: `tweet_id`.

---

## 5. Flujo funcional

```txt
Usuario abre página de bookmarks en X
   ↓
Extensión detecta que está en /i/bookmarks
   ↓
Extensión solicita al backend solo los IDs ya guardados
   ↓
Backend responde lista liviana de tweet_ids
   ↓
Extensión guarda esos IDs en un Set local
   ↓
Scanner recorre posts visibles en DOM
   ↓
Extrae tweet_id de cada post
   ↓
Compara localmente contra IDs guardados
   ↓
Marca posts como:
   - guardado
   - pendiente
   - inválido/no detectable
   ↓
Usuario puede revisar pendientes
   ↓
Usuario importa pendientes en batch
   ↓
Backend guarda nuevos bookmarks
```

---

## 6. Requisitos funcionales

### RF-001 — Detectar página de bookmarks

La extensión debe activar el scanner únicamente cuando la URL corresponda a la página de bookmarks.

Ejemplos válidos:

```txt
https://x.com/i/bookmarks
https://twitter.com/i/bookmarks
```

---

### RF-002 — Extraer IDs de posts visibles

La extensión debe buscar elementos tipo `article` o contenedores equivalentes y extraer el `tweet_id` desde enlaces que contengan `/status/`.

Regla base:

```regex
/status/(\d+)
```

---

### RF-003 — Consultar IDs guardados una sola vez por sesión

Al iniciar el scanner, la extensión debe hacer una única llamada inicial:

```http
GET /bookmarks/ids
```

Respuesta esperada:

```json
{
  "version": "2026-05-02T23:00:00Z",
  "ids": ["123", "456", "789"]
}
```

La extensión debe convertir esta lista en un `Set`.

---

### RF-004 — Comparar localmente

La comparación contra bookmarks existentes debe ocurrir en memoria, no mediante llamadas por cada post.

```js
savedIds.has(tweetId)
```

---

### RF-005 — Detectar nuevos posts con scroll infinito

La extensión debe usar `MutationObserver` para detectar cambios en el DOM.

El scanner debe ejecutarse con debounce para evitar escaneos excesivos.

---

### RF-006 — Evitar reprocesamiento

La extensión debe mantener un `Set` de IDs ya escaneados durante la sesión:

```js
alreadyScannedIds
```

Si un post ya fue procesado, debe ignorarse en escaneos posteriores.

---

### RF-007 — Cola de pendientes

Los posts que están en la página de bookmarks pero no existen en `savedIds` deben agregarse a una cola local:

```js
pendingBookmarks
```

Cada item debe contener como mínimo:

```json
{
  "tweet_id": "123",
  "text": "contenido visible del post",
  "url": "https://x.com/user/status/123",
  "author_handle": "user",
  "detected_at": "2026-05-02T23:00:00Z",
  "source": "x_bookmarks_dom_scan"
}
```

---

### RF-008 — Importar en batch

La extensión debe enviar pendientes al backend solo cuando el usuario lo solicite.

Endpoint:

```http
POST /bookmarks/import-batch
```

Payload:

```json
{
  "source": "x_bookmarks_dom_scan",
  "items": [
    {
      "tweet_id": "123",
      "text": "contenido visible",
      "url": "https://x.com/user/status/123",
      "author_handle": "user"
    }
  ]
}
```

---

### RF-009 — Marcar visualmente posts

Opcional pero recomendado.

La extensión puede inyectar pequeños indicadores visuales sobre cada post:

- `Guardado`
- `Pendiente`
- `Error ID`

Esto no debe romper el layout de X.

---

### RF-010 — Panel de extensión

El popup o panel lateral de la extensión debe mostrar:

```txt
Bookmarks visibles escaneados: 24
Ya guardados: 18
Pendientes: 6
Errores: 0
```

Acciones:

- Re-escanear
- Importar pendientes
- Limpiar cola
- Ver pendientes

---

## 7. Requisitos no funcionales

### RNF-001 — Performance

El scanner no debe bloquear la UI.

Buenas prácticas:

- usar `Set` para búsquedas O(1)
- usar debounce en `MutationObserver`
- procesar solo nodos nuevos
- evitar consultas backend por cada post
- evitar recorrer todo el DOM en intervalos agresivos

---

### RNF-002 — Latencia

El backend solo debe ser llamado en dos momentos principales:

1. carga inicial de IDs guardados
2. importación batch de pendientes

---

### RNF-003 — Seguridad

La extensión no debe ejecutar código remoto.

No debe guardar cookies, tokens de X ni datos sensibles innecesarios.

---

### RNF-004 — Resiliencia

Si X cambia el DOM, el scanner debe fallar de forma segura.

Debe registrar:

- posts sin ID detectable
- errores de parsing
- cantidad de nodos ignorados

---

### RNF-005 — Privacidad

El usuario debe tener control explícito sobre qué posts se importan.

No se deben importar pendientes automáticamente sin acción del usuario.

---

## 8. Arquitectura técnica

```txt
content-script
   ↓
detect bookmarks page
   ↓
fetch saved ids from backend
   ↓
initialize local cache
   ↓
scan DOM
   ↓
extract tweet ids
   ↓
compare with saved ids
   ↓
store pending queue
   ↓
send status to popup
   ↓
user imports pending batch
   ↓
backend persists bookmarks
```

---

## 9. Componentes sugeridos

```txt
extension/
├─ src/
│  ├─ content/
│  │  ├─ bookmarkScanner.ts
│  │  ├─ tweetExtractor.ts
│  │  ├─ domObserver.ts
│  │  └─ postHighlighter.ts
│  │
│  ├─ popup/
│  │  ├─ ScannerPanel.tsx
│  │  └─ PendingList.tsx
│  │
│  ├─ background/
│  │  └─ messageRouter.ts
│  │
│  ├─ api/
│  │  └─ bookmarksApi.ts
│  │
│  └─ storage/
│     └─ localCache.ts
```

---

## 10. Diseño de datos en extensión

### Estado en memoria

```ts
type ScannerState = {
  savedIds: Set<string>;
  alreadyScannedIds: Set<string>;
  pendingBookmarks: Map<string, PendingBookmark>;
  scannedCount: number;
  savedCount: number;
  pendingCount: number;
  errorCount: number;
};
```

### Bookmark pendiente

```ts
type PendingBookmark = {
  tweet_id: string;
  text: string;
  url: string;
  author_handle?: string;
  author_name?: string;
  detected_at: string;
  source: "x_bookmarks_dom_scan";
};
```

---

## 11. Lógica de extracción

### Extraer tweet_id

```ts
function extractTweetIdFromArticle(article: Element): string | null {
  const links = article.querySelectorAll('a[href*="/status/"]');

  for (const link of links) {
    const href = link.getAttribute("href");
    const match = href?.match(/\/status\/(\d+)/);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}
```

---

### Construir URL canónica

```ts
function buildCanonicalTweetUrl(tweetId: string, handle?: string): string {
  if (handle) {
    return `https://x.com/${handle}/status/${tweetId}`;
  }

  return `https://x.com/i/web/status/${tweetId}`;
}
```

---

### Extraer handle

```ts
function extractHandleFromArticle(article: Element): string | null {
  const links = article.querySelectorAll("a[href]");

  for (const link of links) {
    const href = link.getAttribute("href");

    if (!href) continue;

    const match = href.match(/^\/([^/]+)\/status\/\d+/);

    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
}
```

---

## 12. MutationObserver con debounce

```ts
let scanTimer: number | undefined;

const observer = new MutationObserver(() => {
  window.clearTimeout(scanTimer);

  scanTimer = window.setTimeout(() => {
    scanVisibleBookmarks();
  }, 500);
});

observer.observe(document.body, {
  childList: true,
  subtree: true
});
```

---

## 13. Algoritmo principal

```ts
async function initializeBookmarkScanner() {
  const savedIdsResponse = await api.getSavedBookmarkIds();

  const state: ScannerState = {
    savedIds: new Set(savedIdsResponse.ids),
    alreadyScannedIds: new Set(),
    pendingBookmarks: new Map(),
    scannedCount: 0,
    savedCount: 0,
    pendingCount: 0,
    errorCount: 0
  };

  scanVisibleBookmarks(state);
  startDomObserver(state);

  return state;
}
```

```ts
function scanVisibleBookmarks(state: ScannerState) {
  const articles = document.querySelectorAll("article");

  for (const article of articles) {
    const tweetId = extractTweetIdFromArticle(article);

    if (!tweetId) {
      state.errorCount++;
      continue;
    }

    if (state.alreadyScannedIds.has(tweetId)) {
      continue;
    }

    state.alreadyScannedIds.add(tweetId);
    state.scannedCount++;

    const handle = extractHandleFromArticle(article);
    const text = article.textContent?.trim() ?? "";
    const url = buildCanonicalTweetUrl(tweetId, handle ?? undefined);

    if (state.savedIds.has(tweetId)) {
      state.savedCount++;
      markArticleAsSaved(article);
      continue;
    }

    state.pendingBookmarks.set(tweetId, {
      tweet_id: tweetId,
      text,
      url,
      author_handle: handle ?? undefined,
      detected_at: new Date().toISOString(),
      source: "x_bookmarks_dom_scan"
    });

    state.pendingCount++;
    markArticleAsPending(article);
  }

  notifyPopup(state);
}
```

---

## 14. Backend requerido

### Endpoint 1 — IDs guardados

```http
GET /bookmarks/ids
```

Respuesta:

```json
{
  "version": "2026-05-02T23:00:00Z",
  "count": 1240,
  "ids": ["123", "456", "789"]
}
```

Notas:

- debe devolver solo IDs, no bookmarks completos
- respuesta liviana
- puede cachearse

---

### Endpoint 2 — Import batch

```http
POST /bookmarks/import-batch
```

Payload:

```json
{
  "source": "x_bookmarks_dom_scan",
  "items": []
}
```

Respuesta:

```json
{
  "inserted": 6,
  "duplicates": 0,
  "failed": 0
}
```

---

## 15. Backend: comportamiento esperado

El backend debe:

- validar `tweet_id`
- hacer upsert por `tweet_id`
- evitar duplicados
- asociar `source = x_bookmarks_dom_scan`
- responder con resumen del batch
- opcionalmente disparar enrichment posterior

---

## 16. Consideraciones de performance

### No hacer

```txt
❌ consultar backend por cada article
❌ usar setInterval agresivo
❌ recorrer todo el DOM cada 100ms
❌ importar automáticamente sin confirmación
❌ guardar HTML completo del post
```

### Sí hacer

```txt
✅ fetch inicial de IDs
✅ comparación local con Set
✅ MutationObserver con debounce
✅ batch import
✅ cola local
✅ deduplicación por tweet_id
```

---

## 17. Edge cases

### EC-001 — Post sin ID detectable

Acción:

- ignorar
- incrementar `errorCount`
- no romper scanner

---

### EC-002 — X cambia estructura DOM

Acción:

- mantener fallback basado en links `/status/`
- evitar dependencia de clases CSS internas
- usar selectores semánticos como `article`

---

### EC-003 — Tweet repetido en DOM

Acción:

- ignorar si ya está en `alreadyScannedIds`

---

### EC-004 — Backend no disponible

Acción:

- mostrar estado `offline`
- permitir escaneo local
- bloquear import hasta recuperar conexión

---

### EC-005 — Lista de IDs muy grande

Acción:

- cachear `ids` en `chrome.storage.local`
- usar `version`
- futuro: usar Bloom Filter si la lista crece demasiado

---

## 18. Optimización futura: Bloom Filter

Si el usuario tiene decenas o cientos de miles de bookmarks, enviar todos los IDs puede crecer demasiado.

Solución futura:

- backend genera Bloom Filter
- extensión consulta pertenencia localmente
- reduce payload
- admite falsos positivos controlados

Para MVP no es necesario.

---

## 19. Criterios de aceptación

- [ ] El scanner solo se activa en `/i/bookmarks`.
- [ ] La extensión extrae correctamente `tweet_id` desde posts visibles.
- [ ] La extensión consulta IDs guardados solo una vez al iniciar.
- [ ] La comparación contra guardados ocurre localmente.
- [ ] Los posts ya guardados no se agregan a pendientes.
- [ ] Los posts nuevos se agregan a cola pendiente.
- [ ] El scroll infinito dispara escaneo con debounce.
- [ ] No se reprocesan IDs ya vistos.
- [ ] El usuario puede importar pendientes en batch.
- [ ] El backend evita duplicados.
- [ ] La UI muestra conteos claros.
- [ ] El feature no bloquea ni ralentiza la página de X.

---

## 20. Prioridad MVP

### MVP obligatorio

- detección de página bookmarks
- extracción de tweet_id
- fetch inicial de IDs
- comparación local
- cola de pendientes
- import batch

### MVP opcional

- resaltar posts visualmente
- panel de pendientes
- cache persistente en `chrome.storage.local`

### Futuro

- Bloom Filter
- clasificación automática post-import
- detección de repos/tools en pendientes
- selector individual por post
- timeline de sincronización

---

## 21. Resumen técnico

Este feature permite detectar bookmarks no guardados en Indexer sin usar la API de X.

La estrategia eficiente es:

```txt
DOM scan + tweet_id extraction + local Set comparison + batch import
```

Esto minimiza latencia, evita sobrecargar el backend y permite al usuario importar selectivamente contenido que fue guardado fuera del flujo normal de la extensión.
