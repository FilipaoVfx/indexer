-- Template for reusing the backend with another bookmark topic/project.
-- Replace every `bookmarks_other_topic` occurrence with your desired table name,
-- then set BOOKMARKS_TABLE to that same name in Render or backend/.env.

CREATE TABLE IF NOT EXISTS public.bookmarks_other_topic (
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

CREATE INDEX IF NOT EXISTS idx_bookmarks_other_topic_user_id
ON public.bookmarks_other_topic(user_id);

-- If duplicates already slipped in, keep the oldest row for each tweet_id.
WITH ranked AS (
  SELECT
    ctid,
    row_number() OVER (
      PARTITION BY tweet_id
      ORDER BY inserted_at ASC NULLS LAST, ingested_at ASC NULLS LAST, updated_at ASC NULLS LAST, id ASC
    ) AS duplicate_rank
  FROM public.bookmarks_other_topic
)
DELETE FROM public.bookmarks_other_topic AS b
USING ranked AS r
WHERE b.ctid = r.ctid
  AND r.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_bookmarks_other_topic_tweet_id_unique
ON public.bookmarks_other_topic(tweet_id);

CREATE INDEX IF NOT EXISTS idx_bookmarks_other_topic_created_at
ON public.bookmarks_other_topic(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookmarks_other_topic_author
ON public.bookmarks_other_topic(author_username);
