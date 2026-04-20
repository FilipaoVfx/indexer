-- Enable extensions if needed
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create the bookmarks table
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY, -- Using the string ID from rotation/JSON
  user_id TEXT NOT NULL,
  sync_id TEXT,
  tweet_id TEXT NOT NULL,
  text_content TEXT,
  author_username TEXT,
  author_name TEXT,
  created_at TIMESTAMPTZ,
  links TEXT[] DEFAULT '{}', -- Or JSONB if preferred, but JSON has simple strings
  first_comment_links TEXT[] DEFAULT '{}',
  media TEXT[] DEFAULT '{}',
  source_url TEXT,
  ingested_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, tweet_id)
);

-- Index for searching and filtering
CREATE INDEX IF NOT EXISTS idx_bookmarks_user_id ON bookmarks(user_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_tweet_id ON bookmarks(tweet_id);
CREATE INDEX IF NOT EXISTS idx_bookmarks_created_at ON bookmarks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bookmarks_author ON bookmarks(author_username);

CREATE TABLE IF NOT EXISTS bookmark_context_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bookmark_id TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  link_source TEXT NOT NULL CHECK (link_source IN ('first_comment')),
  position INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bookmark_id, link_source, position)
);

CREATE INDEX IF NOT EXISTS idx_bookmark_context_links_bookmark_id
ON bookmark_context_links(bookmark_id);

CREATE INDEX IF NOT EXISTS idx_bookmark_context_links_user_source
ON bookmark_context_links(user_id, link_source);

-- Full Text Search
CREATE INDEX IF NOT EXISTS idx_bookmarks_fts ON bookmarks USING GIN (to_tsvector('spanish', coalesce(text_content, '')));
