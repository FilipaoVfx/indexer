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

-- Full Text Search
CREATE INDEX IF NOT EXISTS idx_bookmarks_fts ON bookmarks USING GIN (to_tsvector('spanish', coalesce(text_content, '')));