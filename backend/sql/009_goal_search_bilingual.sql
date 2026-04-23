-- 009_goal_search_bilingual.sql
--
-- Cross-language goal search: user input is typically in Spanish, but the
-- knowledge corpus (README content, repo names, topics) is overwhelmingly
-- English. This migration closes the gap with two mechanisms:
--
--   1. `unaccent` the goal text before tokenisation so "automatización"
--      becomes "automatizacion" — crucial because `normalize_search_text`
--      keeps accented chars as [:alnum:].
--
--   2. Dictionary-driven query expansion: for every detected step, pull ALL
--      dictionary tokens belonging to that step (English + Spanish alike)
--      and OR them into the tsquery. Since tokens like "automation" and
--      "automatizacion" already share `step = workflow`, the expanded query
--      matches English README content transparently.
--
-- Effect: a Spanish goal "CRM con scraping y automatización de emails" now
-- also searches READMEs for automation, workflow, orchestration, pipeline,
-- etc. — without any external translation service.
--
-- Idempotent: uses CREATE EXTENSION IF NOT EXISTS, ON CONFLICT, OR REPLACE.

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- 1. Extra Spanish-only seed tokens that did not have ES counterparts in 008
-- ---------------------------------------------------------------------------

INSERT INTO public.goal_step_dictionary (token, step, weight, priority) VALUES
  -- extraction
  ('extractor',      'data_extraction', 1.1, 1),
  ('recolector',     'data_extraction', 0.9, 1),
  ('recoleccion',    'data_extraction', 0.9, 1),
  ('scrapear',       'data_extraction', 1.0, 1),
  -- enrichment
  ('limpieza',       'data_enrichment', 0.8, 2),
  ('normalizacion',  'data_enrichment', 0.8, 2),
  ('validacion',     'data_enrichment', 0.7, 2),
  -- storage
  ('almacenamiento', 'storage',         1.2, 3),
  ('guardar',        'storage',         0.7, 3),
  ('persistir',      'storage',         0.9, 3),
  ('persistencia',   'storage',         1.0, 3),
  -- search_layer
  ('buscar',         'search_layer',    1.1, 5),
  ('indexacion',     'search_layer',    1.0, 5),
  ('indice',         'search_layer',    0.8, 5),
  ('indices',        'search_layer',    0.8, 5),
  ('recuperacion',   'search_layer',    1.0, 5),
  -- ai_reasoning
  ('razonamiento',   'ai_reasoning',    1.0, 6),
  ('inferencia',     'ai_reasoning',    1.0, 6),
  ('modelo',         'ai_reasoning',    0.7, 6),
  ('modelos',        'ai_reasoning',    0.7, 6),
  -- workflow
  ('flujo',          'workflow',        1.0, 7),
  ('flujos',         'workflow',        1.0, 7),
  ('cola',           'workflow',        0.7, 7),
  ('colas',          'workflow',        0.7, 7),
  ('programador',    'workflow',        0.7, 7),
  -- outreach
  ('correo',         'outreach',        1.1, 8),
  ('correos',        'outreach',        1.1, 8),
  ('mensajeria',     'outreach',        0.9, 8),
  ('campana',        'outreach',        0.9, 8),   -- "campaña" after unaccent
  ('campanas',       'outreach',        0.9, 8),
  ('contacto',       'outreach',        0.7, 8),
  ('contactos',      'outreach',        0.7, 8),
  -- visualization
  ('tablero',        'visualization',   1.1, 9),
  ('tableros',       'visualization',   1.1, 9),
  ('pantalla',       'visualization',   0.7, 9),
  ('pantallas',      'visualization',   0.7, 9),
  ('grafico',        'visualization',   1.0, 9),
  ('graficos',       'visualization',   1.0, 9),
  -- auth_layer
  ('autenticar',     'auth_layer',      0.9, 10),
  ('autorizacion',   'auth_layer',      0.9, 10),
  -- deployment
  ('desplegar',      'deployment',      1.0, 11),
  ('despliegue',     'deployment',      1.1, 11)
ON CONFLICT (token) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Query-expansion helper
-- ---------------------------------------------------------------------------
--
-- Given the raw tokens, return the UNION of (raw tokens) ∪ (all dictionary
-- tokens sharing a step with any raw token). Deduplicated, lower-cased,
-- only alphanumerics so they are safe to feed into `to_tsquery('simple', …)`
-- joined by ' | '.

CREATE OR REPLACE FUNCTION public.expand_tokens_with_dictionary(p_tokens text[])
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH raw AS (
    SELECT DISTINCT lower(t) AS token
    FROM unnest(coalesce(p_tokens, '{}'::text[])) AS t(t)
    WHERE nullif(trim(t), '') IS NOT NULL
  ),
  matched_steps AS (
    SELECT DISTINCT d.step
    FROM public.goal_step_dictionary d
    JOIN raw ON raw.token = d.token
  ),
  expanded AS (
    SELECT DISTINCT d.token
    FROM public.goal_step_dictionary d
    JOIN matched_steps m ON m.step = d.step
  ),
  all_tokens AS (
    SELECT token FROM raw
    UNION
    SELECT token FROM expanded
  )
  SELECT coalesce(
    ARRAY(
      SELECT token
      FROM all_tokens
      WHERE token ~ '^[a-z0-9_]+$'     -- strip anything that could break tsquery
      ORDER BY token
    ),
    '{}'::text[]
  );
$$;

GRANT EXECUTE ON FUNCTION public.expand_tokens_with_dictionary(text[])
  TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Patched search_goal_v3 — unaccent + query expansion
-- ---------------------------------------------------------------------------

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
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  v_goal_raw        text := nullif(btrim(p_goal), '');
  v_goal            text;
  v_intent          text;
  v_tokens          text[];
  v_tokens_expanded text[];
  v_expanded_str    text;
  v_components      text[];
  v_query_ts        tsquery;
  v_query_ts_exp    tsquery;
  v_query_ts_full   tsquery;
  v_limit           integer := greatest(coalesce(p_limit, 24), 1);
  v_offset          integer := greatest(coalesce(p_offset, 0), 0);
  v_author          text := nullif(lower(btrim(coalesce(p_author, ''))), '');
  v_domain          text := nullif(lower(btrim(coalesce(p_domain, ''))), '');
  v_steps           jsonb;
  v_items           jsonb;
  v_total           bigint := 0;
BEGIN
  IF v_goal_raw IS NULL THEN
    RETURN jsonb_build_object(
      'goal',            NULL,
      'intent',          'explore',
      'tokens',          '[]'::jsonb,
      'tokens_expanded', '[]'::jsonb,
      'components',      '[]'::jsonb,
      'steps',           '[]'::jsonb,
      'items',           '[]'::jsonb,
      'total',           0
    );
  END IF;

  -- 3.1 unaccent + parse -------------------------------------------------
  v_goal       := extensions.unaccent(v_goal_raw);
  v_intent     := public.detect_goal_intent(v_goal);
  v_tokens     := public.extract_search_terms(v_goal, 16, 3);
  v_components := public.detect_goal_components(v_goal);
  v_query_ts   := websearch_to_tsquery('simple', v_goal);

  -- 3.2 dictionary-driven expansion (ES -> EN and vice-versa) ------------
  v_tokens_expanded := public.expand_tokens_with_dictionary(v_tokens);
  v_expanded_str := array_to_string(v_tokens_expanded, ' | ');

  v_query_ts_exp := CASE
    WHEN v_expanded_str IS NULL OR v_expanded_str = '' THEN NULL::tsquery
    ELSE to_tsquery('simple', v_expanded_str)
  END;

  v_query_ts_full := CASE
    WHEN v_query_ts IS NULL OR v_query_ts::text = '' THEN v_query_ts_exp
    WHEN v_query_ts_exp IS NULL THEN v_query_ts
    ELSE v_query_ts || v_query_ts_exp
  END;

  -- guard: an all-stopwords goal would leave the tsquery empty
  IF v_query_ts_full IS NULL OR v_query_ts_full::text = '' THEN
    v_query_ts_full := websearch_to_tsquery('simple', 'zzz_no_match_zzz');
  END IF;

  -- 3.3 step path --------------------------------------------------------
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

  -- 3.4 candidate scoring -------------------------------------------------
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
      ts_rank_cd(ka.search_document, v_query_ts_full)                           AS fts_rank,
      public.array_overlap_count(ka.topics, v_tokens_expanded)                  AS topic_hits,
      public.array_overlap_values(ka.topics, v_tokens_expanded)                 AS matched_topics,
      public.array_overlap_count(ka.required_components, v_components)          AS component_hits,
      public.array_overlap_values(ka.required_components, v_components)         AS matched_components,
      (v_intent = ANY(ka.intent_tags))                                          AS intent_match
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
        ka.search_document @@ v_query_ts_full
        OR ka.topics              && v_tokens_expanded
        OR ka.required_components && v_components
        OR v_intent = ANY(ka.intent_tags)
        OR EXISTS (
          SELECT 1
          FROM unnest(ka.repo_slugs) s
          JOIN unnest(v_tokens_expanded) t(t) ON lower(s) LIKE '%' || t || '%'
        )
      )
  ),
  with_readme AS (
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
        ts_rank_cd(r.content_tsv, v_query_ts_full) AS readme_score
      FROM public.github_repo_readmes r
      WHERE r.status = 'ok'
        AND (
          r.repo_slug = ANY(c.repo_slugs)
          OR r.content_tsv @@ v_query_ts_full
        )
      ORDER BY
        (r.repo_slug = ANY(c.repo_slugs)) DESC,
        ts_rank_cd(r.content_tsv, v_query_ts_full) DESC
      LIMIT 1
    ) rm ON TRUE
  ),
  scored AS (
    SELECT
      w.*,
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
    'goal',            v_goal_raw,
    'intent',          v_intent,
    'tokens',          to_jsonb(v_tokens),
    'tokens_expanded', to_jsonb(v_tokens_expanded),
    'components',      to_jsonb(v_components),
    'steps',           v_steps,
    'items',           v_items,
    'total',           v_total
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.search_goal_v3(
  text, text, text, text, timestamptz, timestamptz, integer, integer
) TO anon, authenticated, service_role;
