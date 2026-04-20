CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE public.bookmarks
ADD COLUMN IF NOT EXISTS first_comment_links text[] NOT NULL DEFAULT '{}'::text[];

CREATE TABLE IF NOT EXISTS public.bookmark_context_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bookmark_id text NOT NULL REFERENCES public.bookmarks(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  link_source text NOT NULL CHECK (link_source IN ('first_comment')),
  position integer NOT NULL DEFAULT 0,
  url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bookmark_id, link_source, position)
);

CREATE INDEX IF NOT EXISTS idx_bookmark_context_links_bookmark_id
ON public.bookmark_context_links(bookmark_id);

CREATE INDEX IF NOT EXISTS idx_bookmark_context_links_user_source
ON public.bookmark_context_links(user_id, link_source);

ALTER TABLE public.bookmark_context_links ENABLE ROW LEVEL SECURITY;

INSERT INTO public.bookmark_context_links (
  bookmark_id,
  user_id,
  link_source,
  position,
  url
)
SELECT
  b.id,
  b.user_id,
  'first_comment',
  link_item.ord - 1,
  link_item.url
FROM public.bookmarks b
CROSS JOIN LATERAL unnest(coalesce(b.first_comment_links, '{}'::text[])) WITH ORDINALITY AS link_item(url, ord)
ON CONFLICT (bookmark_id, link_source, position) DO UPDATE
SET
  url = EXCLUDED.url,
  updated_at = now();
