-- Capa 1: cache liviano de metadata de repositorios de GitHub.
-- Filosofía (docs/contextGithub.md): importar metadata barata primero y
-- descargar/clasificar el README de forma perezosa, solo cuando el repo es
-- relevante. El contenido pesado vive en github_repo_readmes (sql/007) y la
-- clasificación en repo_classifications (sql/010); esta tabla es el índice.

CREATE TABLE IF NOT EXISTS public.github_repositories (
  repo_slug     TEXT PRIMARY KEY,
  github_id     BIGINT,
  owner         TEXT NOT NULL,
  repo          TEXT NOT NULL,
  url           TEXT NOT NULL,
  description   TEXT,
  language      TEXT,
  topics        TEXT[] NOT NULL DEFAULT '{}'::text[],
  stars         INTEGER NOT NULL DEFAULT 0,
  forks         INTEGER NOT NULL DEFAULT 0,
  pushed_at     TIMESTAMPTZ,
  source        TEXT NOT NULL DEFAULT 'bookmark'
                CHECK (source IN ('bookmark', 'github_account')),
  priority      REAL NOT NULL DEFAULT 0,
  readme_status TEXT NOT NULL DEFAULT 'pending'
                CHECK (readme_status IN ('pending', 'indexed', 'failed', 'skipped')),
  metadata_fetched_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (repo_slug ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$')
);

-- Orden de indexación: lo más valioso primero (ver §6 del requerimiento).
CREATE INDEX IF NOT EXISTS idx_github_repositories_priority
ON public.github_repositories(priority DESC, stars DESC);

-- Drenaje de la cola lazy: repos que todavía no tienen README indexado.
CREATE INDEX IF NOT EXISTS idx_github_repositories_readme_status
ON public.github_repositories(readme_status)
WHERE readme_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_github_repositories_source
ON public.github_repositories(source);

-- El backend usa la service role key; RLS habilitado sin policies (igual que
-- sql/007 y sql/010) bloquea acceso anónimo y deja pasar al service role.
ALTER TABLE public.github_repositories ENABLE ROW LEVEL SECURITY;
