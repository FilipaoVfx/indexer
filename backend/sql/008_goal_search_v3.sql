-- 008_goal_search_v3.sql
--
-- Goal search engine v3 — single-RPC, README-aware, step-driven ranking.
--
-- Goals:
--   * Cut /search/goal from 3 DB round-trips (parse → search → readmes) to 1.
--   * Use README content as first-class ranking signal.
--   * Drive a `steps[]` path from a dictionary table (no LLM) so we can
--     compose recommendations per step.
--   * Keep the v2 surface (`parse_goal_query`, `search_goal_assets`) intact so
--     older callers keep working while we migrate the UI to v3.
--
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- 0. Extensions & setup
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1. Step dictionary (token → pipeline step)
-- ---------------------------------------------------------------------------
--
-- The step generator described in goalImprove.md maps goal tokens to canonical
-- pipeline steps. We model it as a small seed table so it is hot-reloadable
-- from SQL without redeploying code.
--
-- Columns:
--   token          lower-cased token extracted from the goal
--   step           canonical step id (data_extraction, storage, outreach, …)
--   weight         per-mapping score contribution (default 1.0)
--   priority       ordering inside the generated path (lower = earlier)
--
-- Priorities are chosen so the canonical pipeline order is:
--   1 data_extraction → 2 data_enrichment → 3 storage → 4 api_layer
-- → 5 search_layer → 6 ai_reasoning → 7 workflow → 8 outreach
-- → 9 visualization → 10 auth_layer → 11 deployment

CREATE TABLE IF NOT EXISTS public.goal_step_dictionary (
  token       text PRIMARY KEY,
  step        text NOT NULL,
  weight      real NOT NULL DEFAULT 1.0,
  priority    smallint NOT NULL DEFAULT 50,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_goal_step_dictionary_step
  ON public.goal_step_dictionary(step);

-- Seed tokens covering the most common goal vocabulary (EN + ES).
-- `ON CONFLICT DO NOTHING` keeps the seed idempotent and never overwrites
-- hand-tuned rows.
INSERT INTO public.goal_step_dictionary (token, step, weight, priority) VALUES
  -- data_extraction ----------------------------------------------------------
  ('scrape',          'data_extraction', 1.2, 1),
  ('scraper',         'data_extraction', 1.2, 1),
  ('scraping',        'data_extraction', 1.2, 1),
  ('crawl',           'data_extraction', 1.1, 1),
  ('crawler',         'data_extraction', 1.1, 1),
  ('crawling',        'data_extraction', 1.1, 1),
  ('extract',         'data_extraction', 1.0, 1),
  ('extraccion',      'data_extraction', 1.0, 1),
  ('harvest',         'data_extraction', 0.9, 1),
  ('fetch',           'data_extraction', 0.8, 1),
  ('ingest',          'data_extraction', 1.0, 1),
  ('ingestion',       'data_extraction', 1.0, 1),
  ('parser',          'data_extraction', 0.9, 1),
  ('parsing',         'data_extraction', 0.9, 1),

  -- data_enrichment ---------------------------------------------------------
  ('enrich',          'data_enrichment', 1.2, 2),
  ('enrichment',      'data_enrichment', 1.2, 2),
  ('enriquecer',      'data_enrichment', 1.2, 2),
  ('clean',           'data_enrichment', 0.8, 2),
  ('dedupe',          'data_enrichment', 0.9, 2),
  ('deduplicate',     'data_enrichment', 0.9, 2),
  ('normalize',       'data_enrichment', 0.8, 2),
  ('transform',       'data_enrichment', 0.8, 2),
  ('etl',             'data_enrichment', 1.1, 2),
  ('validate',        'data_enrichment', 0.7, 2),

  -- storage -----------------------------------------------------------------
  ('storage',         'storage', 1.2, 3),
  ('store',           'storage', 1.0, 3),
  ('almacenar',       'storage', 1.0, 3),
  ('database',        'storage', 1.3, 3),
  ('databases',       'storage', 1.2, 3),
  ('bd',              'storage', 0.9, 3),
  ('postgres',        'storage', 1.2, 3),
  ('postgresql',      'storage', 1.2, 3),
  ('supabase',        'storage', 1.3, 3),
  ('sqlite',          'storage', 1.0, 3),
  ('mysql',           'storage', 1.0, 3),
  ('mongodb',         'storage', 1.0, 3),
  ('redis',           'storage', 0.9, 3),
  ('vector',          'storage', 1.0, 3),
  ('pinecone',        'storage', 1.0, 3),
  ('qdrant',          'storage', 1.0, 3),
  ('weaviate',        'storage', 1.0, 3),
  ('chroma',          'storage', 1.0, 3),

  -- api_layer ---------------------------------------------------------------
  ('api',             'api_layer', 1.2, 4),
  ('endpoint',        'api_layer', 1.1, 4),
  ('endpoints',       'api_layer', 1.1, 4),
  ('rest',            'api_layer', 1.0, 4),
  ('graphql',         'api_layer', 1.0, 4),
  ('sdk',             'api_layer', 0.9, 4),
  ('webhook',         'api_layer', 0.9, 4),
  ('webhooks',        'api_layer', 0.9, 4),
  ('grpc',            'api_layer', 0.9, 4),

  -- search_layer ------------------------------------------------------------
  ('search',          'search_layer', 1.2, 5),
  ('buscador',        'search_layer', 1.2, 5),
  ('busqueda',        'search_layer', 1.2, 5),
  ('retrieval',       'search_layer', 1.1, 5),
  ('ranking',         'search_layer', 1.0, 5),
  ('fts',             'search_layer', 1.0, 5),
  ('elastic',         'search_layer', 1.0, 5),
  ('elasticsearch',   'search_layer', 1.0, 5),
  ('meilisearch',     'search_layer', 1.0, 5),
  ('typesense',       'search_layer', 1.0, 5),
  ('semantic',        'search_layer', 1.0, 5),
  ('semantica',       'search_layer', 1.0, 5),

  -- ai_reasoning ------------------------------------------------------------
  ('llm',             'ai_reasoning', 1.3, 6),
  ('gpt',             'ai_reasoning', 1.1, 6),
  ('claude',          'ai_reasoning', 1.1, 6),
  ('embedding',       'ai_reasoning', 1.1, 6),
  ('embeddings',      'ai_reasoning', 1.1, 6),
  ('rag',             'ai_reasoning', 1.2, 6),
  ('agent',           'ai_reasoning', 1.1, 6),
  ('agents',          'ai_reasoning', 1.1, 6),
  ('agente',          'ai_reasoning', 1.1, 6),
  ('agentes',         'ai_reasoning', 1.1, 6),
  ('prompt',          'ai_reasoning', 0.9, 6),
  ('prompts',         'ai_reasoning', 0.9, 6),
  ('inference',       'ai_reasoning', 1.0, 6),
  ('model',           'ai_reasoning', 0.8, 6),

  -- workflow ----------------------------------------------------------------
  ('automation',      'workflow', 1.2, 7),
  ('automatizacion',  'workflow', 1.2, 7),
  ('automatizar',     'workflow', 1.1, 7),
  ('workflow',        'workflow', 1.2, 7),
  ('workflows',       'workflow', 1.2, 7),
  ('pipeline',        'workflow', 1.1, 7),
  ('orchestration',   'workflow', 1.1, 7),
  ('orquestacion',    'workflow', 1.1, 7),
  ('cron',            'workflow', 0.8, 7),
  ('scheduler',       'workflow', 0.8, 7),
  ('queue',           'workflow', 0.9, 7),
  ('worker',          'workflow', 0.8, 7),

  -- outreach ----------------------------------------------------------------
  ('email',           'outreach', 1.2, 8),
  ('emails',          'outreach', 1.2, 8),
  ('mail',            'outreach', 1.0, 8),
  ('outreach',        'outreach', 1.3, 8),
  ('newsletter',      'outreach', 1.0, 8),
  ('crm',             'outreach', 1.3, 8),
  ('sms',             'outreach', 0.9, 8),
  ('whatsapp',        'outreach', 0.9, 8),
  ('telegram',        'outreach', 0.9, 8),
  ('campaign',        'outreach', 0.9, 8),

  -- visualization -----------------------------------------------------------
  ('dashboard',       'visualization', 1.2, 9),
  ('dashboards',      'visualization', 1.2, 9),
  ('chart',           'visualization', 1.0, 9),
  ('charts',          'visualization', 1.0, 9),
  ('grafica',         'visualization', 1.0, 9),
  ('graficas',        'visualization', 1.0, 9),
  ('report',          'visualization', 0.9, 9),
  ('reporting',       'visualization', 0.9, 9),
  ('reportes',        'visualization', 0.9, 9),
  ('analytics',       'visualization', 1.0, 9),
  ('frontend',        'visualization', 0.7, 9),
  ('ui',              'visualization', 0.6, 9),
  ('astro',           'visualization', 0.7, 9),
  ('react',           'visualization', 0.7, 9),
  ('next',            'visualization', 0.6, 9),

  -- auth_layer --------------------------------------------------------------
  ('auth',            'auth_layer', 1.1, 10),
  ('authentication',  'auth_layer', 1.1, 10),
  ('autenticacion',   'auth_layer', 1.1, 10),
  ('oauth',           'auth_layer', 1.0, 10),
  ('sso',             'auth_layer', 1.0, 10),
  ('jwt',             'auth_layer', 0.9, 10),

  -- deployment --------------------------------------------------------------
  ('deploy',          'deployment', 1.1, 11),
  ('deployment',      'deployment', 1.1, 11),
  ('hosting',         'deployment', 0.9, 11),
  ('docker',          'deployment', 0.9, 11),
  ('kubernetes',      'deployment', 0.9, 11),
  ('vercel',          'deployment', 0.9, 11),
  ('netlify',         'deployment', 0.9, 11),
  ('aws',             'deployment', 0.8, 11),
  ('gcp',             'deployment', 0.8, 11),
  ('azure',           'deployment', 0.8, 11),
  ('cloudflare',      'deployment', 0.9, 11)
ON CONFLICT (token) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. README ranking infrastructure
-- ---------------------------------------------------------------------------

-- Generated tsvector over owner/repo/content (first 8k chars) with field weights.
-- STORED so query-time cost is zero; GIN index makes it matchable in ms.
ALTER TABLE public.github_repo_readmes
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(repo, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(owner, '')), 'B')
    || setweight(to_tsvector('simple', left(coalesce(content, ''), 8000)), 'C')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_github_repo_readmes_content_tsv
  ON public.github_repo_readmes USING GIN (content_tsv);

-- Trigram index for fuzzy repo-name matches ("superbase" → "supabase").
CREATE INDEX IF NOT EXISTS idx_github_repo_readmes_repo_trgm
  ON public.github_repo_readmes USING GIN (repo gin_trgm_ops);

-- Also index knowledge_assets.title for trigram fuzziness in the main query.
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_title_trgm
  ON public.knowledge_assets USING GIN (title gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. Token → step mapper
-- ---------------------------------------------------------------------------
--
-- Given the raw tokens extracted from the goal, return each matched step with
-- an aggregate score and the list of contributing tokens. The path ranker
-- uses this to derive coverage / simplicity later on.

CREATE OR REPLACE FUNCTION public.map_tokens_to_steps(p_tokens text[])
RETURNS TABLE (
  step                 text,
  score                real,
  priority             smallint,
  contributing_tokens  text[]
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    d.step,
    sum(d.weight)::real AS score,
    min(d.priority)::smallint AS priority,
    array_agg(DISTINCT d.token ORDER BY d.token) AS contributing_tokens
  FROM unnest(coalesce(p_tokens, '{}'::text[])) AS t(token)
  JOIN public.goal_step_dictionary d
    ON d.token = t.token
  GROUP BY d.step
  ORDER BY min(d.priority), sum(d.weight) DESC;
$$;

-- ---------------------------------------------------------------------------
-- 4. Unified goal search — parse + search + README attach in ONE round-trip
-- ---------------------------------------------------------------------------
--
-- Returns a single jsonb document:
--   {
--     goal, intent, tokens, components, steps [...],
--     items [ { asset_id, bookmark_id, …, readme: { slug, preview, chars, score } } ],
--     total
--   }
--
-- Scoring weights (sum ≈ 1.0):
--   0.30 fts            (ts_rank_cd over knowledge_assets.search_document)
--   0.22 readme_score   (ts_rank_cd over github_repo_readmes.content_tsv)
--   0.15 topic_overlap  (topics ∩ goal_terms, weighted)
--   0.10 intent_match   (intent tag ∈ intent_tags)
--   0.10 component_match(required_components ∩ goal_components)
--   0.08 asset_type     (explore/build/learn/… asset-type bonus)
--   0.05 freshness      (recency bucket)
--
-- The client still receives why_this_result[] explanations for UX.

CREATE OR REPLACE FUNCTION public.search_goal_v3(
  p_goal text,
  p_user_id text DEFAULT NULL,
  p_author text DEFAULT NULL,
  p_domain text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 24,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_goal            text := nullif(btrim(p_goal), '');
  v_intent          text;
  v_tokens          text[];
  v_components      text[];
  v_query_ts        tsquery;
  v_limit           integer := greatest(coalesce(p_limit, 24), 1);
  v_offset          integer := greatest(coalesce(p_offset, 0), 0);
  v_author          text := nullif(lower(btrim(coalesce(p_author, ''))), '');
  v_domain          text := nullif(lower(btrim(coalesce(p_domain, ''))), '');
  v_steps           jsonb;
  v_items           jsonb;
  v_total           bigint := 0;
BEGIN
  -- 4.1 parse goal ---------------------------------------------------------
  IF v_goal IS NULL THEN
    RETURN jsonb_build_object(
      'goal',       NULL,
      'intent',     'explore',
      'tokens',     '[]'::jsonb,
      'components', '[]'::jsonb,
      'steps',      '[]'::jsonb,
      'items',      '[]'::jsonb,
      'total',      0
    );
  END IF;

  v_intent     := public.detect_goal_intent(v_goal);
  v_tokens     := public.extract_search_terms(v_goal, 16, 3);
  v_components := public.detect_goal_components(v_goal);
  v_query_ts   := websearch_to_tsquery('simple', v_goal);

  -- 4.2 step path (ordered) -----------------------------------------------
  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'step',                s.step,
             'score',               s.score,
             'priority',            s.priority,
             'contributing_tokens', s.contributing_tokens
           )
           ORDER BY s.priority, s.score DESC
         ), '[]'::jsonb)
    INTO v_steps
    FROM public.map_tokens_to_steps(v_tokens) AS s;

  -- 4.3 candidate scoring --------------------------------------------------
  WITH candidates AS (
    SELECT
      ka.id                  AS asset_id,
      ka.bookmark_id,
      ka.user_id,
      b.tweet_id,
      b.text_content,
      b.author_username,
      b.author_name,
      b.created_at,
      b.links,
      b.media,
      b.source_url,
      ka.domain              AS source_domain,
      ka.asset_type,
      ka.title,
      ka.summary,
      ka.topics,
      ka.subtopics,
      ka.intent_tags,
      ka.required_components,
      ka.difficulty,
      ka.repo_slugs,
      ts_rank_cd(ka.search_document, v_query_ts)  AS fts_rank,
      public.array_overlap_count(ka.topics, v_tokens)              AS topic_hits,
      public.array_overlap_values(ka.topics, v_tokens)             AS matched_topics,
      public.array_overlap_count(ka.required_components, v_components) AS component_hits,
      public.array_overlap_values(ka.required_components, v_components) AS matched_components,
      (v_intent = ANY(ka.intent_tags))            AS intent_match
    FROM public.knowledge_assets ka
    JOIN public.bookmarks b ON b.id = ka.bookmark_id
    WHERE (p_user_id IS NULL OR ka.user_id = p_user_id)
      AND (p_from IS NULL OR ka.created_at >= p_from)
      AND (p_to   IS NULL OR ka.created_at <= p_to)
      AND (
        v_author IS NULL
        OR lower(coalesce(ka.author_username, '')) LIKE '%' || v_author || '%'
        OR lower(coalesce(ka.author_name, ''))     LIKE '%' || v_author || '%'
      )
      AND (
        v_domain IS NULL
        OR lower(coalesce(ka.domain, '')) = v_domain
        OR lower(coalesce(ka.source_url, '')) LIKE '%' || v_domain || '%'
      )
      AND (
        ka.search_document @@ v_query_ts
        OR ka.topics              && v_tokens
        OR ka.required_components && v_components
        OR v_intent = ANY(ka.intent_tags)
        OR EXISTS (
          SELECT 1
          FROM unnest(ka.repo_slugs) s
          WHERE lower(s) LIKE '%' || lower(v_tokens[1]) || '%'
        )
      )
  ),
  with_readme AS (
    -- Best README match per candidate (lateral join → one hit per row).
    SELECT
      c.*,
      rm.repo_slug                                     AS readme_slug,
      rm.repo_url                                      AS readme_url,
      left(coalesce(rm.content, ''), 480)              AS readme_preview,
      coalesce(rm.content_chars, 0)                    AS readme_chars,
      coalesce(rm.readme_score, 0)::real               AS readme_score
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT
        r.repo_slug,
        r.repo_url,
        r.content,
        r.content_chars,
        ts_rank_cd(r.content_tsv, v_query_ts) AS readme_score
      FROM public.github_repo_readmes r
      WHERE r.status = 'ok'
        AND (
          r.repo_slug = ANY(c.repo_slugs)
          OR r.content_tsv @@ v_query_ts
        )
      ORDER BY
        (r.repo_slug = ANY(c.repo_slugs)) DESC, -- prefer explicit bookmark link
        ts_rank_cd(r.content_tsv, v_query_ts) DESC
      LIMIT 1
    ) rm ON TRUE
  ),
  scored AS (
    SELECT
      w.*,
      -- individual component scores (bounded so no single signal dominates)
      least(w.fts_rank, 1.0)::real                             AS s_fts,
      least(w.readme_score, 1.0)::real                         AS s_readme,
      (least(w.topic_hits, 5) * 0.20)::real                    AS s_topic,
      (CASE WHEN w.intent_match THEN 1.0 ELSE 0.0 END)::real   AS s_intent,
      (least(w.component_hits, 4) * 0.25)::real                AS s_component,
      (CASE
        WHEN v_intent = 'build'     AND w.asset_type IN ('repo','tool','tutorial')         THEN 1.0
        WHEN v_intent = 'learn'     AND w.asset_type IN ('tutorial','thread','paper','video') THEN 0.85
        WHEN v_intent = 'debug'     AND w.asset_type IN ('thread','tutorial','tool')       THEN 0.75
        WHEN v_intent = 'compare'   AND w.asset_type IN ('tool','repo','paper')            THEN 0.70
        WHEN v_intent = 'integrate' AND w.asset_type IN ('tool','repo','tutorial')         THEN 0.90
        ELSE 0.0
      END)::real                                               AS s_type,
      (CASE
        WHEN w.created_at IS NULL                        THEN 0.0
        WHEN w.created_at >= now() - interval '30 days'  THEN 1.0
        WHEN w.created_at >= now() - interval '90 days'  THEN 0.6
        WHEN w.created_at >= now() - interval '365 days' THEN 0.3
        ELSE 0.0
      END)::real                                               AS s_fresh
    FROM with_readme w
  ),
  ranked AS (
    SELECT
      scored.*,
      (
          0.30 * s_fts
        + 0.22 * s_readme
        + 0.15 * s_topic
        + 0.10 * s_intent
        + 0.10 * s_component
        + 0.08 * s_type
        + 0.05 * s_fresh
      )::real AS combined_score,
      array_remove(
        ARRAY[
          CASE WHEN s_fts       > 0 THEN 'fts'                                                               END,
          CASE WHEN s_readme    > 0 THEN 'readme:' || coalesce(readme_slug, '?')                             END,
          CASE WHEN topic_hits  > 0 THEN 'topics:' || array_to_string(matched_topics, ',')                   END,
          CASE WHEN intent_match    THEN 'intent:' || v_intent                                               END,
          CASE WHEN component_hits > 0 THEN 'components:' || array_to_string(matched_components, ',')        END,
          CASE WHEN s_type      > 0 THEN 'asset_type:' || asset_type                                         END,
          CASE WHEN s_fresh     > 0 THEN 'fresh'                                                             END
        ]::text[],
        NULL
      ) AS why_this_result
    FROM scored
  ),
  paginated AS (
    SELECT
      ranked.*,
      count(*) OVER () AS matched_total
    FROM ranked
    WHERE combined_score > 0
    ORDER BY combined_score DESC, created_at DESC NULLS LAST
    OFFSET v_offset
    LIMIT  v_limit
  )
  SELECT
    coalesce(max(paginated.matched_total), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'asset_id',              paginated.asset_id,
          'bookmark_id',           paginated.bookmark_id,
          'user_id',               paginated.user_id,
          'tweet_id',              paginated.tweet_id,
          'text_content',          paginated.text_content,
          'author_username',       paginated.author_username,
          'author_name',           paginated.author_name,
          'created_at',            paginated.created_at,
          'links',                 paginated.links,
          'media',                 paginated.media,
          'source_url',            paginated.source_url,
          'source_domain',         paginated.source_domain,
          'asset_type',            paginated.asset_type,
          'title',                 paginated.title,
          'summary',               paginated.summary,
          'topics',                paginated.topics,
          'subtopics',             paginated.subtopics,
          'intent_tags',           paginated.intent_tags,
          'required_components',   paginated.required_components,
          'difficulty',            paginated.difficulty,
          'repo_slugs',            paginated.repo_slugs,
          'score',                 paginated.combined_score,
          'score_breakdown',       jsonb_build_object(
            'fts',       paginated.s_fts,
            'readme',    paginated.s_readme,
            'topic',     paginated.s_topic,
            'intent',    paginated.s_intent,
            'component', paginated.s_component,
            'type',      paginated.s_type,
            'fresh',     paginated.s_fresh
          ),
          'why_this_result',       paginated.why_this_result,
          'readme',                CASE
            WHEN paginated.readme_slug IS NULL THEN NULL
            ELSE jsonb_build_object(
              'slug',    paginated.readme_slug,
              'url',     paginated.readme_url,
              'preview', paginated.readme_preview,
              'chars',   paginated.readme_chars,
              'score',   paginated.readme_score
            )
          END
        )
        ORDER BY paginated.combined_score DESC, paginated.created_at DESC NULLS LAST
      ),
      '[]'::jsonb
    )
  INTO v_total, v_items
  FROM paginated;

  RETURN jsonb_build_object(
    'goal',       v_goal,
    'intent',     v_intent,
    'tokens',     to_jsonb(v_tokens),
    'components', to_jsonb(v_components),
    'steps',      v_steps,
    'items',      v_items,
    'total',      v_total
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

GRANT SELECT ON public.goal_step_dictionary TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.map_tokens_to_steps(text[])
  TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.search_goal_v3(
  text, text, text, text, timestamptz, timestamptz, integer, integer
) TO anon, authenticated, service_role;
