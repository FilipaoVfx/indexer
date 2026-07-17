# Manifiesto de Antifragilidad — Sistema Indexer + Bot

> Documento canónico de arquitectura. Antes de agregar cualquier feature, flujo
> de datos o superficie de consumo, léelo. Toda decisión que lo contradiga debe
> justificarse explícitamente aquí mismo (editando este archivo), no en el código.

Última verificación de invariantes: 2026-07-16.

---

## 0. Filosofía

El sistema captura, enriquece y sirve una base de conocimiento personal (bookmarks
de X + READMEs de GitHub) para recuperación semántica. Es operado por **una sola
persona**. Por tanto la meta no es escalar: es **no romperse en silencio**. Cada
componente debe degradar, nunca bloquear; cada dato derivado debe ser regenerable;
cada proceso automático debe ser idempotente o no existir.

**Antifragilidad aquí significa:** un fallo de cualquier pieza deja el sistema en
un estado recuperable con un comando, sin pérdida de la fuente de verdad.

---

## 1. Mapa del sistema

> Diagramas visuales (Excalidraw + PNG): [docs/diagrams/](docs/diagrams/README.md)

```
CAPTURA                        ALMACENES                     CONSUMO
────────                       ─────────                     ───────
Extensión Chrome (MV3)     →   SUPABASE  (verdad única)  ←    Web indexer (GitHub Pages)
 · auto-sync al guardar         · bookmarks                    · búsqueda híbrida SQL
 · import masivo por rango      · github_repo_readmes          · authors/repos/stats server-side
 · captura network-first        · repo_classifications         · (lectura pública)
   (GraphQL de X)               · github_repositories
 · lookup de replies densos     · repo_engagement_metrics ←    Bot Telegram (24/7)
                                · bookmark_github_repos         · búsqueda semántica (Pinecone)
CRONS (GitHub Actions)          · rag_sync_state (índice)       · trust score v3 + stars en vivo
 · rag-ingest 6h (botRepos)     · events / rag_queries_log      · /repos /buscar_repo /insights
 · nightly-enrich (indexer)                              
 · keepalive-loop 2h        →   PINECONE  (derivado, regenerable)
                                · vectores de bookmarks
                                · vectores de READMEs (por heading)
```

Dos repos GitHub, un solo dueño:
- **FilipaoVfx/indexer** — extensión, backend (Render), web (Pages), crons de enriquecimiento.
- **FilipaoVfx/botRepos** — bot de Telegram (PM2 en host propio) + cron de ingesta a Pinecone.

---

## 2. Las 5 reglas (el contrato)

### R1 — Supabase es la única fuente de verdad. Pinecone es derivado y regenerable.

Ningún dato vive **solo** en Pinecone. El índice vectorial se reconstruye por
completo desde Supabase en ~30 min:

```bash
# reconstrucción total del índice vectorial
truncate table rag_sync_state;      # (SQL) olvida qué está indexado
node src/rag-ingest.js all          # re-embebe todo desde Supabase
```

Nunca se escribe en Pinecone sin registrar el `content_hash` en `rag_sync_state`.
Ese registro ES lo que hace la ingesta idempotente y barata (solo re-embebe lo
que cambió).

### R2 — Un solo dueño por almacén.

| Almacén | Único escritor legítimo |
|---|---|
| `bookmarks` y tablas de captura | Backend Render (`upsertBatch`), vía extensión |
| Pinecone | **UN** cron de ingesta (el de botRepos) |
| `repo_classifications`, `github_repositories` | Cron `nightly-enrich` (indexer) |
| `repo_engagement_metrics` | Bot (lazy, al abrir detalle de repo) |

Múltiples escritores al mismo almacén = deriva garantizada. Si dos procesos
necesitan escribir lo mismo, uno de los dos está mal diseñado.

### R3 — Toda feature entra por el backend/orchestrator, nunca por una superficie.

Si el bot gana una capacidad (trust, stars, categorías), el **endpoint** debe
existir para que la web la consuma después. Las superficies (web, bot, extensión)
son clientes tontos de una capa de dominio compartida. Feature que vive solo en
una superficie = deuda de deriva desde el día uno.

### R4 — Los procesos automáticos son idempotentes, o no existen.

Correr un cron dos veces debe dar el mismo resultado que correrlo una. Correrlo a
medias y reintentar no debe duplicar ni corromper. Mecanismos vigentes:
`content_hash` (ingesta), IDs deterministas de vector (`bookmark_<id>_chunk_<i>`),
`onConflict` en upserts, versión de clasificador para invalidar cache.

### R5 — La extensión degrada, nunca bloquea.

MV3 mata el service worker; X cambia su DOM; Render duerme; los tabs en background
se throttlean. Defensas obligatorias, ya implementadas:
- timeout duro en todo `fetch` de salida,
- dead-letter queue (el item que agota reintentos sale de la cola activa),
- `chrome.alarms` para retomar el drenaje tras muerte del worker,
- solo se cachean lookups **exitosos** (un fallo por timing no envenena un tweet),
- captura network-first como fuente primaria; DOM solo como fallback.

---

## 3. Invariantes verificables

Correr periódicamente. Si alguno falla, hay fragilidad activa.

```sql
-- I1: cada bookmark tiene su vector (Pinecone al día con Supabase)
select
  (select count(*) from bookmarks) as bookmarks,
  (select count(*) from rag_sync_state where source_type='bookmark' and chunk_index=0) as vec_bookmarks;
-- deben ser iguales (± lo que esté en vuelo entre corridas del cron)

-- I2: cada README 'ok' tiene su vector
select
  (select count(*) from github_repo_readmes where status='ok') as readmes_ok,
  (select count(*) from rag_sync_state where source_type='readme' and chunk_index=0) as vec_readmes;

-- I3: cada repo conocido está clasificado
select
  (select count(distinct repo_slug) from github_repo_readmes) as repos,
  (select count(*) from repo_classifications) as clasificados;
```

Estado 2026-07-16: I1 = 1814/1814 ✅ · I2 = 366/366 ✅ · I3 = 382/382 ✅.

---

## 4. Procedimientos de recuperación (runbook)

| Síntoma | Causa probable | Recuperación |
|---|---|---|
| Búsqueda del bot vacía o desactualizada | Pinecone atrasado | `node src/rag-ingest.js all` (botRepos) o disparar el cron manual |
| Índice vectorial corrupto/dudoso | — | R1: `truncate rag_sync_state` + re-ingest |
| Web da "CORS"/5xx | Render dormido (cold start) | keepalive-loop lo previene; si persiste, revisar horas de Render |
| Bookmarks densos sin link de repo | reply no capturado a tiempo | re-lookup diferido (extensión) + PATCH `/api/bookmarks/first-comment-links` |
| Cron en rojo | fallo transitorio de API | idempotente: re-disparar sin efectos secundarios |
| Clasificación absurda de un repo | LLM falló → fallback v1 | sube `REPO_CLASSIFIER_LLM_VERSION`, el nightly re-clasifica |
| Bot caído | host/PM2 murió | reiniciar PM2; el bot no toca Render, va directo a Supabase/Pinecone |

---

## 5. Fragilidades conocidas (backlog rankeado)

- **F1 — Doble pipeline de ingesta a Pinecone.** `rag-ingest` corre tanto en el
  cron de botRepos como en el nightly del indexer, con copias de `rag-*.js` que
  ya divergen entre repos. Idempotente (no corrompe, R1/R4), pero doble
  mantenimiento y trabajo redundante. **Acción:** un solo dueño de Pinecone (R2) —
  quitar el paso de Pinecone del nightly; el nightly se queda con clasificar +
  metadata. Unificar los `rag-*.js` en un paquete compartido.
- **F2 — El bot es el único proceso no reproducible desde git.** Corre con PM2 +
  `.env` manual en host propio. Si muere, muere en silencio. **Acción:**
  healthcheck del bot (ping a su dashboard/`PORT`, o `/status` programado).
- **F3 — Deriva de features web ↔ bot.** Trust, stars y categorías LLM solo las
  ve el bot. **Acción (producto, no urgente):** exponerlas en la web (badges en
  ReposList) usando los endpoints que ya existen.
- **F4 — Render free.** 750h/mes; un servicio 24/7 con keepalive-loop roza el
  límite. Vigilar el consumo mensual en el dashboard de Render.
- **F5 — Sin alerta de fallo de crons.** Verificar que llegan los emails de
  scheduled-failure de GitHub, o agregar notificación a Telegram (el bot ya tiene
  token).

---

## 6. Checklist antes de mergear a `main`

- [ ] ¿Introduce un segundo escritor a algún almacén? → viola R2, rediseñar.
- [ ] ¿La feature vive solo en una superficie? → viola R3, exponer endpoint.
- [ ] ¿El nuevo proceso automático es idempotente? → si no, no va (R4).
- [ ] ¿Algún dato queda solo en Pinecone o solo en el cliente? → viola R1.
- [ ] ¿Un fallo de esto bloquea al usuario en vez de degradar? → viola R5.
- [ ] ¿Rompe algún invariante de §3? → correr las queries.
```

Si las seis casillas están limpias, el cambio es antifrágil. Si no, este documento
gana sobre el código.
