-- Apply before deploying the hardened backend. No existing content is deleted.
BEGIN;
ALTER TABLE public.bookmarks ADD COLUMN IF NOT EXISTS capture_source text NOT NULL DEFAULT 'legacy';
ALTER TABLE public.bookmarks ADD COLUMN IF NOT EXISTS content_truncated boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.merge_bookmark_captures(p_bookmarks jsonb)
RETURNS SETOF public.bookmarks
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.bookmarks AS old (
    id, user_id, sync_id, tweet_id, text_content, author_username, author_name,
    created_at, links, first_comment_links, media, source_url,
    ingested_at, inserted_at, updated_at, capture_source, content_truncated
  )
  SELECT r.id, r.user_id, r.sync_id, r.tweet_id, r.text_content,
    r.author_username, r.author_name, r.created_at, r.links,
    r.first_comment_links, r.media, r.source_url, r.ingested_at,
    r.inserted_at, r.updated_at, coalesce(r.capture_source, 'legacy'),
    coalesce(r.content_truncated, false)
  FROM jsonb_to_recordset(p_bookmarks) AS r (
    id text, user_id text, sync_id text, tweet_id text, text_content text,
    author_username text, author_name text, created_at timestamptz,
    links text[], first_comment_links text[], media text[], source_url text,
    ingested_at timestamptz, inserted_at timestamptz, updated_at timestamptz,
    capture_source text, content_truncated boolean
  )
  ON CONFLICT (id) DO UPDATE SET
    text_content = CASE WHEN length(coalesce(excluded.text_content, '')) > length(coalesce(old.text_content, ''))
      THEN excluded.text_content ELSE old.text_content END,
    content_truncated = CASE WHEN length(coalesce(excluded.text_content, '')) > length(coalesce(old.text_content, ''))
      THEN excluded.content_truncated ELSE old.content_truncated END,
    capture_source = CASE WHEN length(coalesce(excluded.text_content, '')) > length(coalesce(old.text_content, ''))
      THEN excluded.capture_source ELSE old.capture_source END,
    author_username = coalesce(nullif(old.author_username, ''), excluded.author_username),
    author_name = coalesce(nullif(old.author_name, ''), excluded.author_name),
    created_at = coalesce(old.created_at, excluded.created_at),
    source_url = coalesce(nullif(old.source_url, ''), excluded.source_url),
    links = ARRAY(SELECT v FROM unnest(coalesce(old.links, '{}') || coalesce(excluded.links, '{}')) WITH ORDINALITY AS u(v, n) GROUP BY v ORDER BY min(n)),
    first_comment_links = ARRAY(SELECT v FROM unnest(coalesce(old.first_comment_links, '{}') || coalesce(excluded.first_comment_links, '{}')) WITH ORDINALITY AS u(v, n) GROUP BY v ORDER BY min(n)),
    media = ARRAY(SELECT v FROM unnest(coalesce(old.media, '{}') || coalesce(excluded.media, '{}')) WITH ORDINALITY AS u(v, n) GROUP BY v ORDER BY min(n)),
    updated_at = greatest(old.updated_at, excluded.updated_at)
  RETURNING old.*;
$$;

-- Deferred URL resolution and self-reply recovery must also merge atomically.
CREATE OR REPLACE FUNCTION public.append_bookmark_links(
  p_id text, p_links text[], p_first_comment_links text[], p_updated_at timestamptz
) RETURNS SETOF public.bookmarks
LANGUAGE sql SET search_path = pg_catalog, public
AS $$
  UPDATE public.bookmarks AS b SET
    links = ARRAY(SELECT v FROM unnest(coalesce(b.links, '{}') || coalesce(p_links, '{}')) WITH ORDINALITY AS u(v, n) GROUP BY v ORDER BY min(n)),
    first_comment_links = ARRAY(SELECT v FROM unnest(coalesce(b.first_comment_links, '{}') || coalesce(p_first_comment_links, '{}')) WITH ORDINALITY AS u(v, n) GROUP BY v ORDER BY min(n)),
    updated_at = greatest(b.updated_at, p_updated_at)
  WHERE b.id = p_id RETURNING b.*;
$$;
REVOKE ALL ON FUNCTION public.append_bookmark_links(text, text[], text[], timestamptz) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.merge_bookmark_captures(jsonb) FROM PUBLIC;
-- Supabase installations have this role; local PostgreSQL tests may not.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.merge_bookmark_captures(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.append_bookmark_links(text, text[], text[], timestamptz) TO service_role;
  END IF;
END $$;
COMMIT;
