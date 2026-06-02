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
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, tweet_id)
);

CREATE INDEX IF NOT EXISTS idx_bookmarks_other_topic_user_id
ON public.bookmarks_other_topic(user_id);

CREATE INDEX IF NOT EXISTS idx_bookmarks_other_topic_tweet_id
ON public.bookmarks_other_topic(tweet_id);

CREATE INDEX IF NOT EXISTS idx_bookmarks_other_topic_created_at
ON public.bookmarks_other_topic(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bookmarks_other_topic_author
ON public.bookmarks_other_topic(author_username);
