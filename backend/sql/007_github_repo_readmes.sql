CREATE TABLE IF NOT EXISTS public.github_repo_readmes (
  repo_slug TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ok', 'not_found', 'error')),
  readme_name TEXT,
  readme_path TEXT,
  readme_sha TEXT,
  readme_html_url TEXT,
  readme_download_url TEXT,
  content TEXT,
  content_chars INTEGER NOT NULL DEFAULT 0,
  content_truncated BOOLEAN NOT NULL DEFAULT false,
  size_bytes INTEGER,
  fetched_at TIMESTAMPTZ,
  last_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  error_message TEXT,
  error_status INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (repo_slug ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$')
);

CREATE TABLE IF NOT EXISTS public.bookmark_github_repos (
  bookmark_id TEXT NOT NULL REFERENCES public.bookmarks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  repo_slug TEXT NOT NULL REFERENCES public.github_repo_readmes(repo_slug) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bookmark_id, repo_slug)
);

CREATE INDEX IF NOT EXISTS idx_github_repo_readmes_status
ON public.github_repo_readmes(status, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_repo_readmes_updated
ON public.github_repo_readmes(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookmark_github_repos_user
ON public.bookmark_github_repos(user_id, repo_slug);

CREATE INDEX IF NOT EXISTS idx_bookmark_github_repos_repo
ON public.bookmark_github_repos(repo_slug);

ALTER TABLE public.github_repo_readmes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookmark_github_repos ENABLE ROW LEVEL SECURITY;
