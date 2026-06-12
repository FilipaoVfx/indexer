# Integración con GitHub — Requerimiento y diseño

> Filosofía rectora (de [`contextGithub.md`](./contextGithub.md)):
> **No sincronices todo. Extrae conocimiento útil, no repos.**
> El README es la materia prima; la **capacidad extraída** es el activo.

Este documento traduce esa filosofía a la arquitectura real de Indexer: qué hay
hoy, qué falta, y el plan por fases para integrar GitHub sin caer en el
anti-patrón de "conectar → indexar todo".

---

## 1. Objetivo

Permitir que un usuario **conecte su cuenta de GitHub** (o que entren repos vía
bookmarks, como hoy) y que Indexer:

1. Importe **solo metadata liviana** de sus repos en segundos.
2. Descargue READMEs **de forma perezosa** (lazy), solo cuando el repo es
   relevante (búsqueda, Goal Mode, ver repo).
3. Procese en **background con prioridad**, no en el request path.
4. Mantenga todo **incremental** (re-indexar solo lo que cambió).
5. Extraiga **capabilities** como activo reutilizable para el Goal Engine.

No-goals: replicar GitHub, clonar repos, descargar árbol de archivos, indexar
código fuente completo.

---

## 2. Estado actual (lo que ya existe)

| Pieza | Dónde | Estado |
|---|---|---|
| Repos derivados de bookmarks | `bookmark_github_repos` (`sql/007`) | ✅ |
| Cache de README + status | `github_repo_readmes` (`status`: pending/ok/not_found/error) | ✅ |
| Fetch de README desde la API de GitHub | `backend/src/github-readmes.js` → `fetchGithubReadmeRow` | ✅ |
| Clasificación / capabilities | `repo_classifications` (`sql/010`), `repo-classifier.js` | ✅ |
| TTL de refresco | `GITHUB_README_TTL_HOURS` (168h) + `shouldFetchGithubReadme()` | ✅ |
| Token | `GITHUB_TOKEN` / `GH_TOKEN` en `config.js` | ✅ |
| API de lectura | `GET /api/github-readmes`, `GET /api/github-readmes/:owner/:repo` | ✅ |
| UI | `web-astro/src/components/RepoReadmesList.tsx`, `ReposList.tsx` | ✅ |

### Cómo fluye hoy
```txt
Ingesta de bookmarks (upsertBatch)
  └─ processGithubReadmesForBookmarks
       ├─ syncBookmarkGithubRepos   → upsert repo_slug (pending) + junction
       └─ fetchGithubReadmesForSlugs → DESCARGA README (tope 8/batch) + clasifica
                                       ⚠️ sincrónico, en el request path
```

---

## 3. Brechas vs la filosofía

| # | Brecha | Síntoma | Fase que la cierra |
|---|---|---|---|
| B1 | No hay **metadata cache** liviano | Solo conocemos `repo_slug`; sin stars/forks/topics/lenguaje/`pushed_at` | Fase 1 |
| B2 | Fetch de README **eager en el request path** | Latencia en ingesta; tope arbitrario de 8 | Fase 2 |
| B3 | Sin **modelo de prioridad** | Se descargan los primeros 8 al azar, no los más valiosos | Fase 2 |
| B4 | Sin **cola durable** (`sync_jobs`) | No hay reintentos, backpressure ni workers | Fase 3 |
| B5 | Incremental **solo por TTL** | No compara `pushed_at` de GitHub → refetch innecesario | Fase 3 |
| B6 | Sin **webhooks** | Se re-escanea por tiempo, no por evento | Fase 4 |
| B7 | Sin **OAuth / GitHub App** | No se puede importar la cuenta del usuario, solo repos de bookmarks | Fase 1 |

---

## 4. Arquitectura objetivo

```txt
Connect GitHub (OAuth/App)
        ↓
Import Metadata  ──────────►  Capa 1: repositories (liviano, KB)
        ↓
Score + Queue Jobs ────────►  Capa 4: sync_jobs (prioridad)
        ↓
Background Workers
        ↓
Lazy README Fetch ─────────►  Capa 2: github_repo_readmes (status)
        ↓
Capability Extraction ─────►  Capa 3: repo_classifications (el activo)
        ↓
Webhooks (incremental) ────►  re-encola solo el repo que cambió
```

Una vez extraída la capability, **la mayoría de consultas no vuelven a leer el
README** — operan sobre la capacidad extraída.

---

## 5. Modelo de datos (cambios propuestos)

### 5.1 Nueva tabla — metadata cache (Capa 1)
```sql
-- sql/014_github_repositories.sql
CREATE TABLE public.github_repositories (
  repo_slug     TEXT PRIMARY KEY,            -- owner/repo (lowercase)
  github_id     BIGINT,                      -- id estable de GitHub
  owner         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  url           TEXT NOT NULL,
  description   TEXT,
  language      TEXT,
  topics        TEXT[] NOT NULL DEFAULT '{}',
  stars         INTEGER NOT NULL DEFAULT 0,
  forks         INTEGER NOT NULL DEFAULT 0,
  pushed_at     TIMESTAMPTZ,                 -- para sync incremental (B5)
  source        TEXT NOT NULL DEFAULT 'bookmark', -- bookmark | github_account
  priority      REAL NOT NULL DEFAULT 0,     -- score (ver §6)
  readme_status TEXT NOT NULL DEFAULT 'pending'
                CHECK (readme_status IN ('pending','indexed','failed','skipped')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
> `github_repo_readmes` (contenido pesado) y `repo_classifications` se mantienen
> como están y referencian `repo_slug`. La nueva tabla es el índice liviano.

### 5.2 Nueva tabla — cola de jobs (Capa 4)
```sql
CREATE TABLE public.github_sync_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT,
  repo_slug   TEXT NOT NULL REFERENCES public.github_repositories(repo_slug) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'readme'  -- readme | classify | metadata
              CHECK (kind IN ('readme','classify','metadata')),
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','failed')),
  priority    REAL NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  run_after   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_github_sync_jobs_pick
  ON public.github_sync_jobs (status, priority DESC, run_after)
  WHERE status = 'queued';
```

---

## 6. Modelo de prioridad

```txt
priority =  w1 * log2(1 + stars)
          + w2 * log2(1 + forks)
          + w3 * recencia(pushed_at)     -- decae con el tiempo
          + w4 * (#topics > 0)
          + w5 * (tiene README)
          + w6 * (#bookmarks que lo mencionan)   -- señal propia de Indexer
```
Repos con score alto se indexan primero; los de score bajo, después o nunca
(quedan en `pending` hasta que alguien los abra). Pesos configurables por env.

---

## 7. Sync incremental

```txt
GitHub.pushed_at  >  github_repositories.pushed_at  ?  → reindex (encola job)
                  ==                                 ?  → SKIP
```
Reemplaza el refetch ciego por TTL: el TTL pasa a ser un *fallback* (p.ej. 30
días) por si nos perdemos un webhook.

---

## 8. API

| Método | Ruta | Propósito | Fase |
|---|---|---|---|
| `GET`  | `/api/github/connect` | Inicia OAuth (redirect a GitHub) | 1 |
| `GET`  | `/api/github/callback` | Callback OAuth → guarda token, encola import metadata | 1 |
| `POST` | `/api/github/sync` | Re-importa metadata de la cuenta (incremental) | 1 |
| `GET`  | `/api/github/repositories` | Lista metadata liviana (paginada, ordenada por priority) | 1 |
| `POST` | `/api/github/repositories/:slug/index` | Fuerza fetch README + classify (lazy on-demand) | 2 |
| `POST` | `/api/github/webhook` | Recibe eventos push/repo → encola job del repo | 4 |

`GET /api/github-readmes` (actual) se mantiene para lectura del contenido.

---

## 9. Plan por fases

Mapea las fases de `contextGithub.md`. **Las fases 1–2 no requieren infra nueva**
(corren con el backend actual + Supabase); 3–4 sí.

- **Fase 1 — Metadata Only**
  - `sql/014_github_repositories.sql` (Capa 1).
  - OAuth GitHub App + `GET /api/github/repositories` paginado.
  - Import = solo `GET /user/repos` → metadata liviana. Conexión en segundos.
  - *Entregable sin OAuth:* poblar `github_repositories` desde los `repo_slug`
    que ya existen en `github_repo_readmes`/bookmarks + backfill de metadata.

- **Fase 2 — Lazy README + Prioridad**
  - Sacar `fetchGithubReadmesForSlugs` del request path de ingesta (B2).
  - Al ingestar/conectar: solo `upsert` metadata + `readme_status='pending'`.
  - Fetch real disparado on-demand por `/repositories/:slug/index` o al abrir el
    repo en la UI. Orden por `priority` (§6).

- **Fase 3 — Background Queue**
  - `github_sync_jobs` + worker. Empezar con un worker **in-process** que draina
    la cola con `SELECT ... FOR UPDATE SKIP LOCKED` (sin Redis).
  - Subir a **BullMQ + Upstash Redis** si el volumen lo exige.
  - Sync incremental por `pushed_at` (B5).

- **Fase 4 — Webhooks**
  - `POST /api/github/webhook` (push, repository, rename) → encola solo ese repo.

---

## 10. Decisiones abiertas

- **Fuente primaria**: ¿conectar cuenta GitHub (OAuth) o seguir derivando de
  bookmarks? El diseño soporta ambas vía `github_repositories.source`.
- **Cola**: in-process (Postgres `SKIP LOCKED`) vs BullMQ/Redis. Recomendado
  empezar in-process y migrar si hace falta.
- **GitHub App vs OAuth App**: App da rate limits mejores y webhooks finos;
  OAuth es más simple para MVP.

---

## 11. Definición de "hecho" (Fase 1)

Estado de la **fundación sin infra** (implementada en código):

- [x] Migración `014_github_repositories.sql` creada (Capa 1).
- [x] Backfill `repos:backfill` siembra desde los `repo_slug` existentes y
      enriquece metadata (stars/forks/topics/`pushed_at`) + `priority`.
- [x] `GET /api/github/repositories` devuelve la lista liviana ordenada por priority.
- [x] Ingesta de bookmarks deja de descargar READMEs en el request path
      (solo marca `pending` + siembra metadata). Flag `GITHUB_README_EAGER_FETCH`
      restaura el comportamiento anterior.
- [x] README se descarga **lazy al verlo** (endpoints de lectura, acotado a
      `GITHUB_README_MAX_PER_BATCH`), sin cola ni infra nueva.
- [ ] (Operacional) Aplicar la migración en Supabase y correr el backfill.
- [ ] (Fase 1 completa) OAuth/GitHub App para importar la cuenta del usuario.

### Archivos
| Archivo | Cambio |
|---|---|
| `backend/sql/014_github_repositories.sql` | Tabla metadata cache (nuevo) |
| `backend/src/github-repos-metadata.js` | `fetchRepoMetadata` + `computeRepoPriority` + mapeo de estado (nuevo) |
| `backend/src/backfill-github-repositories.js` | Backfill seed + enrich (nuevo) |
| `backend/src/store.js` | `ensureRepositoryRows`, `upsertRepositoryMetadata`, `listRepositories`, `refreshPendingReadmes`, ingesta lazy |
| `backend/src/server.js` | `GET /api/github/repositories` + disparo lazy en lectura |
| `backend/src/config.js` | `GITHUB_README_EAGER_FETCH` |

## 12. Activación

```bash
# 1. Aplicar la migración en Supabase (SQL editor o psql)
#    backend/sql/014_github_repositories.sql

# 2. Sembrar + enriquecer metadata desde los repos ya conocidos
cd backend
GITHUB_TOKEN=ghp_xxx npm run repos:backfill            # todos
GITHUB_TOKEN=ghp_xxx npm run repos:backfill -- --limit=50   # primeros 50
npm run repos:backfill -- --dry-run                    # sin escribir

# 3. (Opcional) revisar la metadata
curl "$BACKEND/api/github/repositories?limit=20"
```

A partir de aquí, la ingesta de bookmarks ya no descarga READMEs en línea: los
marca `pending` y se descargan cuando alguien los ve (o al correr el backfill).
