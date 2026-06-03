-- Concrete table for a second bookmark corpus.
-- Render env must use: BOOKMARKS_TABLE=bookmarks_crypto

CREATE TABLE IF NOT EXISTS public.bookmarks_crypto (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sync_id TEXT,
  tweet_id TEXT NOT NULL,
  text_content TEXT,
  author_username TEXT,
  author_name TEXT,
  created_at TIMESTAMPTZ,
  links TEXT[] DEFAULT '{}',
  first_comment_links TEXT[] DEFAULT '{}',
  media TEXT[] DEFAULT '{}',
  source_url TEXT,
  ingested_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_crypto_user_id
ON public.bookmarks_crypto(user_id);

-- If duplicates already slipped in, keep the oldest row for each tweet_id.
WITH ranked AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY tweet_id
      ORDER BY inserted_at ASC NULLS LAST, ingested_at ASC NULLS LAST, updated_at ASC NULLS LAST, id ASC
    ) AS duplicate_rank
  FROM public.bookmarks_crypto
)
DELETE FROM public.bookmarks_crypto AS b
USING ranked AS r
WHERE b.ctid = r.ctid
  AND r.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_crypto_tweet_id_unique
ON public.bookmarks_crypto(tweet_id);

CREATE INDEX IF NOT EXISTS idx_bookmarks_crypto_created_at
ON public.bookmarks_crypto(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookmarks_crypto_author
ON public.bookmarks_crypto(author_username);

CREATE OR REPLACE VIEW public.bookmarks_crypto_public_feed AS
SELECT
  text_content,
  author_username,
  author_name,
  created_at,
  links,
  first_comment_links,
  media,
  source_url,
  ingested_at,
  updated_at,
  inserted_at
FROM public.bookmarks_crypto;

CREATE OR REPLACE VIEW public.bookmarks_crypto_dashboard_summary AS
SELECT
  COUNT(*) AS total_bookmarks,
  COUNT(DISTINCT NULLIF(author_username, '')) AS unique_authors,
  COUNT(*) FILTER (WHERE cardinality(media) > 0) AS bookmarks_with_media,
  COUNT(*) FILTER (
    WHERE cardinality(links) > 0
       OR cardinality(first_comment_links) > 0
  ) AS bookmarks_with_links,
  MIN(created_at) AS oldest_created_at,
  MAX(created_at) AS newest_created_at,
  MAX(inserted_at) AS last_inserted_at
FROM public.bookmarks_crypto;
