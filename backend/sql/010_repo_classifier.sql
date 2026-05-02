CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.repo_classifications (
  repo_slug TEXT PRIMARY KEY
    REFERENCES public.github_repo_readmes(repo_slug) ON DELETE CASCADE,
  primary_category TEXT,
  secondary_categories TEXT[] NOT NULL DEFAULT '{}'::text[],
  capabilities TEXT[] NOT NULL DEFAULT '{}'::text[],
  input_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  output_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  integration_types TEXT[] NOT NULL DEFAULT '{}'::text[],
  target_domains TEXT[] NOT NULL DEFAULT '{}'::text[],
  tech_stack TEXT[] NOT NULL DEFAULT '{}'::text[],
  deployment_modes TEXT[] NOT NULL DEFAULT '{}'::text[],
  constraints TEXT[] NOT NULL DEFAULT '{}'::text[],
  complexity TEXT NOT NULL DEFAULT 'intermediate'
    CHECK (complexity IN ('basic', 'intermediate', 'advanced')),
  maturity TEXT NOT NULL DEFAULT 'unknown'
    CHECK (maturity IN ('unknown', 'prototype', 'usable', 'production')),
  confidence REAL NOT NULL DEFAULT 0,
  classifier_version TEXT NOT NULL,
  score_breakdown JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.repo_classification_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_slug TEXT NOT NULL
    REFERENCES public.github_repo_readmes(repo_slug) ON DELETE CASCADE,
  classifier_version TEXT NOT NULL,
  label_type TEXT NOT NULL,
  label_value TEXT NOT NULL,
  evidence_text TEXT NOT NULL,
  source_section TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_primary_category
  ON public.repo_classifications(primary_category);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_updated
  ON public.repo_classifications(updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_secondary_categories
  ON public.repo_classifications USING GIN (secondary_categories);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_capabilities
  ON public.repo_classifications USING GIN (capabilities);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_input_types
  ON public.repo_classifications USING GIN (input_types);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_output_types
  ON public.repo_classifications USING GIN (output_types);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_integration_types
  ON public.repo_classifications USING GIN (integration_types);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_target_domains
  ON public.repo_classifications USING GIN (target_domains);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_tech_stack
  ON public.repo_classifications USING GIN (tech_stack);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_deployment_modes
  ON public.repo_classifications USING GIN (deployment_modes);

CREATE INDEX IF NOT EXISTS idx_repo_classifications_constraints
  ON public.repo_classifications USING GIN (constraints);

CREATE INDEX IF NOT EXISTS idx_repo_classification_evidence_repo
  ON public.repo_classification_evidence(repo_slug, label_type, label_value);

CREATE INDEX IF NOT EXISTS idx_repo_classification_evidence_weight
  ON public.repo_classification_evidence(repo_slug, weight DESC);

ALTER TABLE public.repo_classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.repo_classification_evidence ENABLE ROW LEVEL SECURITY;
