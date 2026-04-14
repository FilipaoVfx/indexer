CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_bookmarks_fts_simple
  ON bookmarks
  USING GIN (
    to_tsvector(
      'simple',
      coalesce(text_content, '')
      || ' '
      || coalesce(author_username, '')
      || ' '
      || coalesce(author_name, '')
    )
  );

CREATE INDEX IF NOT EXISTS idx_bookmarks_source_url_trgm
  ON bookmarks
  USING GIN (source_url gin_trgm_ops);

CREATE OR REPLACE FUNCTION search_bookmarks(
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
AS $$
  WITH input AS (
    SELECT
      NULLIF(btrim(search_query), '') AS normalized_query,
      NULLIF(lower(btrim(author_filter)), '') AS normalized_author,
      NULLIF(lower(btrim(domain_filter)), '') AS normalized_domain,
      GREATEST(COALESCE(limit_count, 50), 1) AS normalized_limit,
      GREATEST(COALESCE(offset_count, 0), 0) AS normalized_offset
  ),
  base AS (
    SELECT
      b.*,
      i.normalized_query,
      i.normalized_author,
      i.normalized_domain,
      i.normalized_limit,
      i.normalized_offset,
      CASE
        WHEN i.normalized_query IS NULL THEN NULL::tsquery
        ELSE websearch_to_tsquery('simple', i.normalized_query)
      END AS query_ts,
      to_tsvector(
        'simple',
        coalesce(b.text_content, '')
        || ' '
        || coalesce(b.author_username, '')
        || ' '
        || coalesce(b.author_name, '')
      ) AS document_vector
    FROM bookmarks b
    CROSS JOIN input i
    WHERE (user_filter IS NULL OR b.user_id = user_filter)
      AND (from_date IS NULL OR b.created_at >= from_date)
      AND (to_date IS NULL OR b.created_at <= to_date)
      AND (
        i.normalized_author IS NULL
        OR lower(coalesce(b.author_username, '')) LIKE '%' || i.normalized_author || '%'
        OR lower(coalesce(b.author_name, '')) LIKE '%' || i.normalized_author || '%'
      )
      AND (
        i.normalized_domain IS NULL
        OR lower(coalesce(b.source_url, '')) LIKE '%' || i.normalized_domain || '%'
      )
  ),
  matched AS (
    SELECT *
    FROM base
    WHERE query_ts IS NULL
      OR document_vector @@ query_ts
  ),
  scored AS (
    SELECT
      matched.*,
      CASE
        WHEN query_ts IS NULL THEN 0::real
        ELSE ts_rank_cd(document_vector, query_ts)::real
      END AS lexical_score,
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
      scored.media,
      scored.source_url,
      scored.ingested_at,
      scored.updated_at,
      scored.inserted_at,
      (scored.lexical_score + scored.author_match_score + scored.freshness_score)::real AS combined_score,
      scored.lexical_score,
      scored.author_match_score,
      scored.freshness_score,
      CASE
        WHEN scored.query_ts IS NULL THEN coalesce(scored.text_content, '')
        ELSE ts_headline(
          'simple',
          coalesce(scored.text_content, ''),
          scored.query_ts,
          'MaxFragments=0, MaxWords=500, MinWords=50, ShortWord=2, HighlightAll=TRUE, StartSel=<mark>, StopSel=</mark>'
        )
      END AS preview_text,
      COUNT(*) OVER() AS matched_total,
      scored.normalized_limit,
      scored.normalized_offset
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
    paged.media,
    paged.source_url,
    paged.ingested_at,
    paged.updated_at,
    paged.inserted_at,
    paged.combined_score AS score,
    paged.lexical_score AS text_rank,
    paged.author_match_score AS author_boost,
    paged.freshness_score AS freshness_boost,
    paged.preview_text AS highlight,
    paged.matched_total AS total_count
  FROM paged
  OFFSET (SELECT normalized_offset FROM input)
  LIMIT (SELECT normalized_limit FROM input);
$$;
