-- Electoral YouTube ETL tables.
-- Same Supabase/Postgres database as the browser extension, but isolated from
-- bookmarks/bookmarks_crypto so the extension corpus and electoral analytics do
-- not share tables or constraints.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.electoral_youtube_raw_comments (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'youtube',
  comment_id TEXT NOT NULL UNIQUE,
  video_id TEXT NOT NULL,
  video_title TEXT,
  source_url TEXT,
  political_cluster TEXT,
  candidate_reference TEXT,
  collection_batch TEXT,
  author_display_name TEXT,
  author_channel_url TEXT,
  published_at TIMESTAMPTZ,
  comment_updated_at TIMESTAMPTZ,
  text_original TEXT NOT NULL,
  like_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  batch_id TEXT,
  page_index INTEGER,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_raw_video
ON public.electoral_youtube_raw_comments(video_id);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_raw_batch
ON public.electoral_youtube_raw_comments(batch_id);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_raw_published
ON public.electoral_youtube_raw_comments(published_at DESC);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_raw_cluster
ON public.electoral_youtube_raw_comments(political_cluster);

CREATE TABLE IF NOT EXISTS public.electoral_youtube_processed_comments (
  id BIGSERIAL PRIMARY KEY,
  raw_comment_id BIGINT NOT NULL
    REFERENCES public.electoral_youtube_raw_comments(id) ON DELETE CASCADE,
  text_clean TEXT,
  language TEXT NOT NULL DEFAULT 'es',
  word_count INTEGER NOT NULL DEFAULT 0,
  is_valid_for_analysis BOOLEAN NOT NULL DEFAULT FALSE,
  quality_reason TEXT NOT NULL DEFAULT 'not_processed',
  dedupe_key TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (raw_comment_id)
);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_processed_valid
ON public.electoral_youtube_processed_comments(is_valid_for_analysis, quality_reason);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_processed_dedupe
ON public.electoral_youtube_processed_comments(dedupe_key);

CREATE TABLE IF NOT EXISTS public.electoral_youtube_analysis_results (
  id BIGSERIAL PRIMARY KEY,
  processed_comment_id BIGINT NOT NULL
    REFERENCES public.electoral_youtube_processed_comments(id) ON DELETE CASCADE,
  political_segment TEXT NOT NULL DEFAULT 'no_clasificable'
    CHECK (political_segment IN (
      'centro',
      'indeciso',
      'abstencionista',
      'voto_blanco',
      'anti_extremos',
      'pro_candidato_a',
      'pro_candidato_b',
      'anti_candidato_a',
      'anti_candidato_b',
      'militante_duro',
      'no_clasificable'
    )),
  sentiment TEXT NOT NULL DEFAULT 'neutral'
    CHECK (sentiment IN ('positivo', 'negativo', 'neutral', 'mixto')),
  sentiment_intensity NUMERIC NOT NULL DEFAULT 0
    CHECK (sentiment_intensity >= 0 AND sentiment_intensity <= 100),
  primary_emotion TEXT NOT NULL DEFAULT 'no_clasificable'
    CHECK (primary_emotion IN (
      'miedo',
      'esperanza',
      'rabia',
      'frustracion',
      'confianza',
      'incertidumbre',
      'indiferencia',
      'no_clasificable'
    )),
  emotion_intensity NUMERIC NOT NULL DEFAULT 0
    CHECK (emotion_intensity >= 0 AND emotion_intensity <= 100),
  main_topic TEXT NOT NULL DEFAULT 'otro'
    CHECK (main_topic IN (
      'seguridad',
      'economia',
      'corrupcion',
      'salud',
      'educacion',
      'instituciones',
      'polarizacion',
      'centro_politico',
      'abstencion',
      'voto_en_blanco',
      'rechazo_candidato',
      'segunda_vuelta',
      'otro'
    )),
  secondary_topic TEXT NOT NULL DEFAULT 'otro'
    CHECK (secondary_topic IN (
      'seguridad',
      'economia',
      'corrupcion',
      'salud',
      'educacion',
      'instituciones',
      'polarizacion',
      'centro_politico',
      'abstencion',
      'voto_en_blanco',
      'rechazo_candidato',
      'segunda_vuelta',
      'otro'
    )),
  mobility_score INTEGER NOT NULL DEFAULT 0
    CHECK (mobility_score >= 0 AND mobility_score <= 100),
  transfer_signal TEXT NOT NULL DEFAULT 'no_aplica'
    CHECK (transfer_signal IN ('hacia_a', 'hacia_b', 'abstencion', 'voto_blanco', 'indefinido', 'no_aplica')),
  justification TEXT,
  analysis_is_valid BOOLEAN NOT NULL DEFAULT TRUE,
  analysis_errors TEXT[] NOT NULL DEFAULT '{}'::text[],
  raw_ai_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  model_name TEXT,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (processed_comment_id)
);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_analysis_segment
ON public.electoral_youtube_analysis_results(political_segment);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_analysis_sentiment
ON public.electoral_youtube_analysis_results(sentiment);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_analysis_emotion
ON public.electoral_youtube_analysis_results(primary_emotion);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_analysis_topic
ON public.electoral_youtube_analysis_results(main_topic);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_analysis_mobility
ON public.electoral_youtube_analysis_results(mobility_score DESC);

CREATE TABLE IF NOT EXISTS public.electoral_youtube_etl_runs (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  videos_processed INTEGER NOT NULL DEFAULT 0,
  comments_extracted INTEGER NOT NULL DEFAULT 0,
  comments_valid INTEGER NOT NULL DEFAULT 0,
  comments_failed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_etl_runs_batch
ON public.electoral_youtube_etl_runs(batch_id);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_etl_runs_started
ON public.electoral_youtube_etl_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS public.electoral_youtube_etl_errors (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT,
  node_name TEXT,
  source_item_id TEXT,
  error_message TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_etl_errors_batch
ON public.electoral_youtube_etl_errors(batch_id);

CREATE INDEX IF NOT EXISTS idx_electoral_youtube_etl_errors_item
ON public.electoral_youtube_etl_errors(source_item_id);

ALTER TABLE public.electoral_youtube_raw_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.electoral_youtube_processed_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.electoral_youtube_analysis_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.electoral_youtube_etl_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.electoral_youtube_etl_errors ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE VIEW public.electoral_youtube_dashboard_summary AS
SELECT
  ar.political_segment,
  ar.sentiment,
  ar.primary_emotion,
  ar.main_topic,
  COUNT(*) AS total_comments,
  AVG(ar.mobility_score) AS avg_mobility,
  COUNT(*) FILTER (WHERE ar.mobility_score >= 70) AS high_mobility_comments
FROM public.electoral_youtube_analysis_results ar
GROUP BY
  ar.political_segment,
  ar.sentiment,
  ar.primary_emotion,
  ar.main_topic;

CREATE OR REPLACE VIEW public.electoral_youtube_fact_comments AS
SELECT
  ryc.id AS raw_comment_id,
  pc.id AS processed_comment_id,
  ar.id AS analysis_result_id,
  ryc.source,
  ryc.video_id,
  ryc.video_title,
  ryc.source_url,
  ryc.political_cluster,
  ryc.candidate_reference,
  ryc.collection_batch,
  ryc.comment_id,
  ryc.author_display_name,
  ryc.published_at,
  ryc.like_count,
  ryc.reply_count,
  ryc.batch_id,
  pc.text_clean,
  pc.word_count,
  pc.is_valid_for_analysis,
  pc.quality_reason,
  ar.political_segment,
  ar.sentiment,
  ar.sentiment_intensity,
  ar.primary_emotion,
  ar.emotion_intensity,
  ar.main_topic,
  ar.secondary_topic,
  ar.mobility_score,
  ar.transfer_signal,
  ar.model_name,
  ar.analyzed_at
FROM public.electoral_youtube_raw_comments ryc
JOIN public.electoral_youtube_processed_comments pc
  ON pc.raw_comment_id = ryc.id
LEFT JOIN public.electoral_youtube_analysis_results ar
  ON ar.processed_comment_id = pc.id;

CREATE OR REPLACE VIEW public.electoral_youtube_public_fact_comments AS
SELECT
  ryc.source,
  ryc.video_title,
  ryc.source_url,
  ryc.political_cluster,
  ryc.candidate_reference,
  ryc.collection_batch,
  ryc.author_display_name,
  ryc.published_at,
  ryc.like_count,
  ryc.reply_count,
  pc.text_clean,
  pc.word_count,
  pc.is_valid_for_analysis,
  pc.quality_reason,
  ar.political_segment,
  ar.sentiment,
  ar.sentiment_intensity,
  ar.primary_emotion,
  ar.emotion_intensity,
  ar.main_topic,
  ar.secondary_topic,
  ar.mobility_score,
  ar.transfer_signal,
  ar.model_name,
  ar.analyzed_at
FROM public.electoral_youtube_raw_comments ryc
JOIN public.electoral_youtube_processed_comments pc
  ON pc.raw_comment_id = ryc.id
LEFT JOIN public.electoral_youtube_analysis_results ar
  ON ar.processed_comment_id = pc.id;
