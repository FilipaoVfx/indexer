CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

ALTER TABLE public.bookmarks
ADD COLUMN IF NOT EXISTS first_comment_links text[] NOT NULL DEFAULT '{}'::text[];

CREATE OR REPLACE FUNCTION public.normalize_search_text(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT trim(
    regexp_replace(
      translate(
        lower(
          regexp_replace(
            regexp_replace(
              coalesce(p_text, ''),
              '([[:upper:]]+)([[:upper:]][[:lower:]])',
              '\1 \2',
              'g'
            ),
            '([[:lower:][:digit:]])([[:upper:]])',
            '\1 \2',
            'g'
          )
        ),
        'áéíóúüñàèìòùäëïöâêîôûç',
        'aeiouunaeiouaeioaeiouc'
      ),
      '[^[:alnum:]]+',
      ' ',
      'g'
    )
  );
$$;

DROP INDEX IF EXISTS public.idx_bookmarks_fts_simple;
DROP INDEX IF EXISTS public.idx_bookmarks_search_text_trgm;

DROP FUNCTION IF EXISTS public.bookmarks_fts_simple_doc(text, text, text, text, text[]);
DROP FUNCTION IF EXISTS public.bookmarks_fts_simple_doc(text, text, text, text, text[], text[]);
DROP FUNCTION IF EXISTS public.bookmarks_search_text(text, text, text, text, text[]);
DROP FUNCTION IF EXISTS public.bookmarks_search_text(text, text, text, text, text[], text[]);
DROP FUNCTION IF EXISTS public.search_bookmarks(text, text, text, text, timestamptz, timestamptz, integer, integer);

CREATE OR REPLACE FUNCTION public.bookmarks_search_text(
  p_text_content text,
  p_author_username text,
  p_author_name text,
  p_source_url text,
  p_links text[],
  p_first_comment_links text[] DEFAULT '{}'::text[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT public.normalize_search_text(
    concat_ws(
      ' ',
      coalesce(p_text_content, ''),
      coalesce(p_author_username, ''),
      coalesce(p_author_name, ''),
      coalesce(p_source_url, ''),
      coalesce(array_to_string(p_links, ' '), ''),
      coalesce(array_to_string(p_first_comment_links, ' '), ''),
      coalesce(
        array_to_string(
          public.extract_repo_slugs(p_text_content, p_source_url, p_links),
          ' '
        ),
        ''
      )
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.bookmarks_fts_simple_doc(
  p_text_content text,
  p_author_username text,
  p_author_name text,
  p_source_url text,
  p_links text[],
  p_first_comment_links text[] DEFAULT '{}'::text[]
)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT to_tsvector(
    'simple',
    public.bookmarks_search_text(
      p_text_content,
      p_author_username,
      p_author_name,
      p_source_url,
      p_links,
      p_first_comment_links
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.build_prefix_tsquery(
  p_text text,
  p_limit integer DEFAULT 12,
  p_min_length integer DEFAULT 2
)
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH terms AS (
    SELECT public.extract_search_terms(p_text, p_limit, p_min_length) AS tokens
  )
  SELECT CASE
    WHEN coalesce(array_length(tokens, 1), 0) = 0 THEN NULL::tsquery
    ELSE to_tsquery(
      'simple',
      array_to_string(
        ARRAY(
          SELECT token || ':*'
          FROM unnest(tokens) AS token
          WHERE token <> ''
        ),
        ' & '
      )
    )
  END
  FROM terms;
$$;

CREATE INDEX IF NOT EXISTS idx_bookmarks_fts_simple
ON public.bookmarks
USING GIN (
  public.bookmarks_fts_simple_doc(
    text_content,
    author_username,
    author_name,
    source_url,
    links,
    first_comment_links
  )
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_search_text_trgm
ON public.bookmarks
USING GIN (
  public.bookmarks_search_text(
    text_content,
    author_username,
    author_name,
    source_url,
    links,
    first_comment_links
  ) gin_trgm_ops
);

CREATE OR REPLACE FUNCTION public.search_bookmarks(
  search_query text DEFAULT NULL,
  user_filter text DEFAULT NULL,
  author_filter text DEFAULT NULL,
  domain_filter text DEFAULT NULL,
  from_date timestamptz DEFAULT NULL,
  to_date timestamptz DEFAULT NULL,
  limit_count integer DEFAULT 50,
  offset_count integer DEFAULT 0
)
RETURNS TABLE (
  id text,
  user_id text,
  sync_id text,
  tweet_id text,
  text_content text,
  author_username text,
  author_name text,
  created_at timestamptz,
  links text[],
  first_comment_links text[],
  media text[],
  source_url text,
  ingested_at timestamptz,
  updated_at timestamptz,
  inserted_at timestamptz,
  score real,
  text_rank real,
  author_boost real,
  freshness_boost real,
  highlight text,
  total_count bigint
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH input AS (
    SELECT
      NULLIF(btrim(search_query), '') AS raw_query,
      NULLIF(public.normalize_search_text(search_query), '') AS normalized_query,
      public.extract_search_terms(search_query, 12, 2) AS query_terms,
      NULLIF(lower(btrim(author_filter)), '') AS normalized_author,
      NULLIF(lower(btrim(domain_filter)), '') AS normalized_domain,
      GREATEST(COALESCE(limit_count, 50), 1) AS normalized_limit,
      GREATEST(COALESCE(offset_count, 0), 0) AS normalized_offset
  ),
  prepared AS (
    SELECT
      i.*,
      NULLIF(array_to_string(i.query_terms, ' '), '') AS query_terms_text,
      CASE
        WHEN coalesce(array_length(i.query_terms, 1), 0) = 0 THEN NULL::text
        ELSE '%' || array_to_string(i.query_terms, '%') || '%'
      END AS query_like_pattern,
      CASE
        WHEN i.raw_query IS NULL THEN NULL::tsquery
        ELSE websearch_to_tsquery('simple', i.raw_query)
      END AS query_ts,
      public.build_prefix_tsquery(i.raw_query, 12, 2) AS prefix_ts,
      coalesce(array_length(i.query_terms, 1), 0) AS query_term_count
    FROM input i
  ),
  base AS (
    SELECT
      b.*,
      p.raw_query,
      p.normalized_query,
      p.query_terms_text,
      p.query_like_pattern,
      p.query_ts,
      p.prefix_ts,
      p.query_term_count,
      p.normalized_author,
      p.normalized_domain,
      p.normalized_limit,
      p.normalized_offset,
      public.bookmarks_search_text(
        b.text_content,
        b.author_username,
        b.author_name,
        b.source_url,
        b.links,
        b.first_comment_links
      ) AS search_text,
      public.bookmarks_fts_simple_doc(
        b.text_content,
        b.author_username,
        b.author_name,
        b.source_url,
        b.links,
        b.first_comment_links
      ) AS document_vector
    FROM public.bookmarks b
    CROSS JOIN prepared p
    WHERE (user_filter IS NULL OR b.user_id = user_filter)
      AND (from_date IS NULL OR b.created_at >= from_date)
      AND (to_date IS NULL OR b.created_at <= to_date)
      AND (
        p.normalized_author IS NULL
        OR lower(coalesce(b.author_username, '')) LIKE '%' || p.normalized_author || '%'
        OR lower(coalesce(b.author_name, '')) LIKE '%' || p.normalized_author || '%'
      )
      AND (
        p.normalized_domain IS NULL
        OR lower(coalesce(b.source_url, '')) LIKE '%' || p.normalized_domain || '%'
      )
  ),
  matched AS (
    SELECT *
    FROM base
    WHERE normalized_query IS NULL
      OR (query_ts IS NOT NULL AND document_vector @@ query_ts)
      OR (prefix_ts IS NOT NULL AND document_vector @@ prefix_ts)
      OR (
        query_like_pattern IS NOT NULL
        AND query_term_count <= 4
        AND search_text LIKE query_like_pattern
      )
      OR (
        query_terms_text IS NOT NULL
        AND query_term_count <= 4
        AND word_similarity(search_text, query_terms_text) >=
          CASE
            WHEN query_term_count = 1 THEN 0.22
            ELSE 0.34
          END
      )
  ),
  scored AS (
    SELECT
      matched.*,
      CASE
        WHEN query_ts IS NULL THEN 0::real
        ELSE (ts_rank_cd(document_vector, query_ts) * 2.2)::real
      END AS lexical_score,
      CASE
        WHEN prefix_ts IS NULL THEN 0::real
        ELSE (ts_rank_cd(document_vector, prefix_ts) * 1.3)::real
      END AS prefix_score,
      CASE
        WHEN query_like_pattern IS NULL THEN 0::real
        WHEN search_text LIKE query_like_pattern THEN
          CASE
            WHEN query_term_count = 1 THEN 0.45::real
            ELSE 0.30::real
          END
        ELSE 0::real
      END AS substring_score,
      CASE
        WHEN query_terms_text IS NULL THEN 0::real
        ELSE (
          greatest(
            word_similarity(search_text, query_terms_text),
            similarity(search_text, query_terms_text)
          ) *
          CASE
            WHEN query_term_count = 1 THEN 1.10
            ELSE 0.75
          END
        )::real
      END AS trigram_score,
      CASE
        WHEN normalized_author IS NULL THEN 0::real
        WHEN lower(coalesce(author_username, '')) = normalized_author THEN 0.45::real
        WHEN lower(coalesce(author_name, '')) = normalized_author THEN 0.35::real
        WHEN lower(coalesce(author_username, '')) LIKE '%' || normalized_author || '%' THEN 0.20::real
        WHEN lower(coalesce(author_name, '')) LIKE '%' || normalized_author || '%' THEN 0.16::real
        ELSE 0::real
      END AS author_match_score,
      CASE
        WHEN created_at IS NULL THEN 0::real
        WHEN created_at >= now() - interval '14 days' THEN 0.08::real
        WHEN created_at >= now() - interval '60 days' THEN 0.05::real
        WHEN created_at >= now() - interval '180 days' THEN 0.02::real
        ELSE 0::real
      END AS freshness_score
    FROM matched
  ),
  paged AS (
    SELECT
      scored.id,
      scored.user_id,
      scored.sync_id,
      scored.tweet_id,
      scored.text_content,
      scored.author_username,
      scored.author_name,
      scored.created_at,
      scored.links,
      scored.first_comment_links,
      scored.media,
      scored.source_url,
      scored.ingested_at,
      scored.updated_at,
      scored.inserted_at,
      (
        scored.lexical_score
        + scored.prefix_score
        + scored.substring_score
        + scored.trigram_score
        + scored.author_match_score
        + scored.freshness_score
      )::real AS combined_score,
      (
        scored.lexical_score
        + scored.prefix_score
        + scored.substring_score
        + scored.trigram_score
      )::real AS text_relevance_score,
      scored.author_match_score,
      scored.freshness_score,
      CASE
        WHEN scored.query_ts IS NOT NULL AND scored.document_vector @@ scored.query_ts THEN
          ts_headline(
            'simple',
            coalesce(scored.text_content, ''),
            scored.query_ts,
            'MaxFragments=0, MaxWords=500, MinWords=50, ShortWord=2, HighlightAll=TRUE, StartSel=<mark>, StopSel=</mark>'
          )
        ELSE coalesce(scored.text_content, '')
      END AS preview_text,
      COUNT(*) OVER() AS matched_total
    FROM scored
    ORDER BY combined_score DESC, created_at DESC NULLS LAST
  )
  SELECT
    paged.id,
    paged.user_id,
    paged.sync_id,
    paged.tweet_id,
    paged.text_content,
    paged.author_username,
    paged.author_name,
    paged.created_at,
    paged.links,
    paged.first_comment_links,
    paged.media,
    paged.source_url,
    paged.ingested_at,
    paged.updated_at,
    paged.inserted_at,
    paged.combined_score AS score,
    paged.text_relevance_score AS text_rank,
    paged.author_match_score AS author_boost,
    paged.freshness_score AS freshness_boost,
    paged.preview_text AS highlight,
    paged.matched_total AS total_count
  FROM paged
  OFFSET (SELECT normalized_offset FROM input)
  LIMIT (SELECT normalized_limit FROM input);
$$;
