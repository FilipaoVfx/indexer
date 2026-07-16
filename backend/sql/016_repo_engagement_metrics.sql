-- Migration 016: Repo Engagement Metrics & Trust Score
-- Almacena métricas de interacción de redes sociales para repositorios
-- y el trust score calculado (0-10) basado en engagement real

CREATE TABLE IF NOT EXISTS public.repo_engagement_metrics (
  repo_slug TEXT PRIMARY KEY REFERENCES public.github_repo_readmes(repo_slug) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  mentions_count INT DEFAULT 1,
  avg_likes NUMERIC(10,2) DEFAULT 0,
  avg_impressions NUMERIC(12,2) DEFAULT 0,
  avg_interactions NUMERIC(12,2) DEFAULT 0,
  avg_saves NUMERIC(10,2) DEFAULT 0,
  avg_shares NUMERIC(10,2) DEFAULT 0,
  avg_replies NUMERIC(10,2) DEFAULT 0,
  avg_reposts NUMERIC(10,2) DEFAULT 0,
  avg_profile_visits NUMERIC(10,2) DEFAULT 0,
  avg_url_clicks NUMERIC(10,2) DEFAULT 0,
  avg_engagement_rate NUMERIC(5,2) DEFAULT 0,
  avg_like_rate NUMERIC(5,2) DEFAULT 0,
  trust_score NUMERIC(4,2) DEFAULT 0,
  trust_score_version INT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_engagement_trust_score
  ON public.repo_engagement_metrics(trust_score DESC);

-- Trigger para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION public.update_repo_engagement_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_repo_engagement_updated_at ON public.repo_engagement_metrics;
CREATE TRIGGER trg_repo_engagement_updated_at
  BEFORE UPDATE ON public.repo_engagement_metrics
  FOR EACH ROW
  EXECUTE FUNCTION public.update_repo_engagement_updated_at();
