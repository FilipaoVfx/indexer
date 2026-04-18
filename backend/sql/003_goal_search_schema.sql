CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.bookmarks_fts_simple_doc(
  p_text_content text,
  p_author_username text,
  p_author_name text
)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT to_tsvector(
    'simple',
    concat_ws(
      ' ',
      coalesce(p_text_content, ''),
      coalesce(p_author_username, ''),
      coalesce(p_author_name, '')
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.normalize_search_text(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT trim(
    regexp_replace(
      lower(coalesce(p_text, '')),
      '[^[:alnum:]:/._ -]+',
      ' ',
      'g'
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.extract_search_terms(
  p_text text,
  p_limit integer DEFAULT 12,
  p_min_length integer DEFAULT 3
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH tokens AS (
    SELECT
      token,
      ord
    FROM regexp_split_to_table(public.normalize_search_text(p_text), E'\\s+') WITH ORDINALITY AS t(token, ord)
    WHERE token <> ''
  ),
  dedup AS (
    SELECT
      token,
      min(ord) AS first_ord
    FROM tokens
    WHERE length(token) >= greatest(coalesce(p_min_length, 3), 1)
      AND token <> ALL (
        ARRAY[
          'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'con',
          'de', 'del', 'do', 'el', 'en', 'for', 'from', 'how', 'i', 'in',
          'into', 'is', 'it', 'la', 'las', 'los', 'me', 'mi', 'my', 'of',
          'on', 'or', 'para', 'por', 'que', 'quiero', 'the', 'to', 'tu',
          'un', 'una', 'y', 'your'
        ]::text[]
      )
    GROUP BY token
  )
  SELECT coalesce(
    ARRAY(
      SELECT token
      FROM dedup
      ORDER BY first_ord
      LIMIT greatest(coalesce(p_limit, 12), 1)
    ),
    '{}'::text[]
  );
$$;

CREATE OR REPLACE FUNCTION public.extract_domain(p_url text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT nullif(
    regexp_replace(
      lower(
        coalesce(
          substring(trim(coalesce(p_url, '')) FROM '^(?:https?://)?(?:www\\.)?([^/?#]+)'),
          ''
        )
      ),
      '^www\\.',
      ''
    ),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.extract_repo_slugs(
  p_text text,
  p_source_url text,
  p_links text[]
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    ARRAY(
      SELECT DISTINCT lower(
        (match_parts)[1] || '/' || regexp_replace((match_parts)[2], '\\.git$', '', 'i')
      )
      FROM regexp_matches(
        concat_ws(
          ' ',
          coalesce(p_source_url, ''),
          coalesce(array_to_string(p_links, ' '), ''),
          coalesce(p_text, '')
        ),
        'github\\.com/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9][A-Za-z0-9._-]{0,99})(?=[/?#\\s]|$)',
        'gi'
      ) AS match_parts
      ORDER BY 1
    ),
    '{}'::text[]
  );
$$;

CREATE OR REPLACE FUNCTION public.truncate_text(
  p_text text,
  p_max_length integer DEFAULT 220
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN char_length(trim(coalesce(p_text, ''))) = 0 THEN ''
    WHEN char_length(trim(p_text)) <= greatest(coalesce(p_max_length, 220), 16) THEN trim(p_text)
    ELSE left(trim(p_text), greatest(coalesce(p_max_length, 220), 16) - 3) || '...'
  END;
$$;

CREATE OR REPLACE FUNCTION public.derive_asset_title(
  p_text text,
  p_source_url text,
  p_repo_slugs text[],
  p_author_username text,
  p_author_name text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    nullif(public.truncate_text(split_part(regexp_replace(coalesce(p_text, ''), E'[\\r\\n]+', ' ', 'g'), '.', 1), 120), ''),
    nullif(public.truncate_text(array_to_string(p_repo_slugs, ', '), 120), ''),
    nullif(public.truncate_text(p_source_url, 120), ''),
    nullif(trim(coalesce(p_author_name, '')), ''),
    nullif(trim(coalesce(p_author_username, '')), ''),
    'Untitled asset'
  );
$$;

CREATE OR REPLACE FUNCTION public.infer_asset_type(
  p_text text,
  p_repo_slugs text[],
  p_media text[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN cardinality(coalesce(p_repo_slugs, '{}'::text[])) > 0 THEN 'repo'
    WHEN lower(coalesce(p_text, '')) ~ '(tutorial|guide|step by step|how to)' THEN 'tutorial'
    WHEN lower(coalesce(p_text, '')) ~ '(tool|framework|library|sdk|mcp|cli)' THEN 'tool'
    WHEN cardinality(coalesce(p_media, '{}'::text[])) > 0
      AND lower(coalesce(p_text, '')) ~ '(video|demo|watch)' THEN 'video'
    WHEN lower(coalesce(p_text, '')) ~ '(paper|research|arxiv)' THEN 'paper'
    ELSE 'thread'
  END;
$$;

CREATE OR REPLACE FUNCTION public.infer_difficulty(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN lower(coalesce(p_text, '')) ~ '(beginner|basic|intro|101)' THEN 'basic'
    WHEN lower(coalesce(p_text, '')) ~ '(advanced|deep dive|production|optimiz)' THEN 'advanced'
    ELSE 'intermediate'
  END;
$$;

CREATE OR REPLACE FUNCTION public.detect_goal_intent(p_goal text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(build|create|make|ship|launch|prototype|construir|crear|hacer|lanzar|prototipo)($|[^[:alnum:]])' THEN 'build'
    WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(learn|understand|study|explore|aprender|entender|estudiar|explorar)($|[^[:alnum:]])' THEN 'learn'
    WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(debug|fix|solve|troubleshoot|depurar|arreglar|resolver|solucionar)($|[^[:alnum:]])' THEN 'debug'
    WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(compare|choose|evaluate|vs|comparar|elegir|evaluar)($|[^[:alnum:]])' THEN 'compare'
    WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(integrate|connect|sync|plug|integrar|conectar|sincronizar)($|[^[:alnum:]])' THEN 'integrate'
    ELSE 'explore'
  END;
$$;

CREATE OR REPLACE FUNCTION public.detect_goal_components(p_goal text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT array_remove(
    ARRAY[
      CASE WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(agent|agents|assistant|copilot|agente|agentes|asistente)($|[^[:alnum:]])' THEN 'agent' END,
      CASE WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(api|endpoint|endpoints|rest|graphql|sdk)($|[^[:alnum:]])' THEN 'api' END,
      CASE WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(automation|workflow|pipeline|orchestr|automatizacion|automatizar|flujo)($|[^[:alnum:]])' THEN 'automation' END,
      CASE WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(database|databases|db|bd|postgres|supabase|sql|base de datos)($|[^[:alnum:]])' THEN 'database' END,
      CASE WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(frontend|ui|astro|react|next|web|interfaz|pantalla)($|[^[:alnum:]])' THEN 'frontend' END,
      CASE WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(graph|graphs|grafo|grafos|knowledge graph|grafo de conocimiento|relation|relations|relacion|relaciones)($|[^[:alnum:]])' THEN 'graph' END,
      CASE WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(llm|rag|embedding|embeddings|prompt|prompts|gpt|model|modelo|modelos)($|[^[:alnum:]])' THEN 'llm' END,
      CASE WHEN lower(coalesce(p_goal, '')) ~ '(^|[^[:alnum:]])(search|buscar|busqueda|buscador|retrieval|ranking|fts|semantic|semantica|semantico)($|[^[:alnum:]])' THEN 'search' END
    ]::text[],
    NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.infer_required_components(p_text text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT public.detect_goal_components(p_text);
$$;

CREATE OR REPLACE FUNCTION public.infer_intent_tags(
  p_text text,
  p_asset_type text
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT array_remove(
    ARRAY[
      CASE
        WHEN lower(coalesce(p_text, '')) ~ '(build|create|ship|launch|implementation)'
          OR coalesce(p_asset_type, '') IN ('repo', 'tool') THEN 'build'
      END,
      CASE
        WHEN lower(coalesce(p_text, '')) ~ '(learn|guide|tutorial|understand|explain)'
          OR coalesce(p_asset_type, '') IN ('tutorial', 'paper', 'video') THEN 'learn'
      END,
      CASE
        WHEN lower(coalesce(p_text, '')) ~ '(debug|fix|troubleshoot|issue|error)' THEN 'debug'
      END,
      CASE
        WHEN lower(coalesce(p_text, '')) ~ '(compare|versus|vs|benchmark|evaluate)' THEN 'compare'
      END,
      CASE
        WHEN lower(coalesce(p_text, '')) ~ '(integrate|connect|sync|plugin|adapter)' THEN 'integrate'
      END
    ]::text[],
    NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.array_overlap_values(
  p_left text[],
  p_right text[]
)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(
    ARRAY(
      SELECT DISTINCT left_value
      FROM unnest(coalesce(p_left, '{}'::text[])) AS left_value
      JOIN unnest(coalesce(p_right, '{}'::text[])) AS right_value
        ON left_value = right_value
      WHERE nullif(btrim(left_value), '') IS NOT NULL
      ORDER BY 1
    ),
    '{}'::text[]
  );
$$;

CREATE OR REPLACE FUNCTION public.array_overlap_count(
  p_left text[],
  p_right text[]
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT cardinality(public.array_overlap_values(p_left, p_right));
$$;

CREATE OR REPLACE FUNCTION public.knowledge_asset_search_doc(
  p_title text,
  p_summary text,
  p_topics text[],
  p_subtopics text[],
  p_intent_tags text[],
  p_required_components text[],
  p_author_username text,
  p_author_name text,
  p_domain text,
  p_repo_slugs text[]
)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT to_tsvector(
    'simple',
    concat_ws(
      ' ',
      coalesce(p_title, ''),
      coalesce(p_summary, ''),
      coalesce(array_to_string(p_topics, ' '), ''),
      coalesce(array_to_string(p_subtopics, ' '), ''),
      coalesce(array_to_string(p_intent_tags, ' '), ''),
      coalesce(array_to_string(p_required_components, ' '), ''),
      coalesce(p_author_username, ''),
      coalesce(p_author_name, ''),
      coalesce(p_domain, ''),
      coalesce(array_to_string(p_repo_slugs, ' '), '')
    )
  );
$$;

CREATE TABLE IF NOT EXISTS public.knowledge_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bookmark_id text NOT NULL UNIQUE REFERENCES public.bookmarks(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  asset_type text NOT NULL CHECK (asset_type IN ('thread', 'tool', 'repo', 'tutorial', 'paper', 'video')),
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  topics text[] NOT NULL DEFAULT '{}'::text[],
  subtopics text[] NOT NULL DEFAULT '{}'::text[],
  intent_tags text[] NOT NULL DEFAULT '{}'::text[],
  required_components text[] NOT NULL DEFAULT '{}'::text[],
  difficulty text NOT NULL DEFAULT 'intermediate' CHECK (difficulty IN ('basic', 'intermediate', 'advanced')),
  canonical_url text,
  domain text,
  author_username text,
  author_name text,
  source_url text,
  repo_slugs text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_document tsvector NOT NULL DEFAULT ''::tsvector
);

CREATE INDEX IF NOT EXISTS idx_knowledge_assets_user_id ON public.knowledge_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_created_at ON public.knowledge_assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_asset_type ON public.knowledge_assets(asset_type);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_domain ON public.knowledge_assets(domain);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_author_username ON public.knowledge_assets(author_username);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_topics ON public.knowledge_assets USING GIN (topics);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_intent_tags ON public.knowledge_assets USING GIN (intent_tags);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_required_components ON public.knowledge_assets USING GIN (required_components);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_repo_slugs ON public.knowledge_assets USING GIN (repo_slugs);
CREATE INDEX IF NOT EXISTS idx_knowledge_assets_search_document ON public.knowledge_assets USING GIN (search_document);

CREATE TABLE IF NOT EXISTS public.entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('tool', 'framework', 'person', 'concept')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, normalized_name, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_entities_user_id ON public.entities(user_id);
CREATE INDEX IF NOT EXISTS idx_entities_lookup ON public.entities(user_id, entity_type, normalized_name);

CREATE TABLE IF NOT EXISTS public.asset_entities (
  user_id text NOT NULL,
  asset_id uuid NOT NULL REFERENCES public.knowledge_assets(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES public.entities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_entities_user_id ON public.asset_entities(user_id);
CREATE INDEX IF NOT EXISTS idx_asset_entities_entity_id ON public.asset_entities(entity_id);

CREATE TABLE IF NOT EXISTS public.relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  source_asset_id uuid NOT NULL REFERENCES public.knowledge_assets(id) ON DELETE CASCADE,
  target_asset_id uuid NOT NULL REFERENCES public.knowledge_assets(id) ON DELETE CASCADE,
  relation_type text NOT NULL CHECK (relation_type IN ('relates_to', 'requires', 'alternative_to', 'extends', 'inspired_by', 'same_goal_as', 'same_author', 'same_domain', 'shared_repo', 'shared_topic')),
  score real NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_asset_id, target_asset_id, relation_type),
  CHECK (source_asset_id <> target_asset_id)
);

CREATE INDEX IF NOT EXISTS idx_relations_user_id ON public.relations(user_id);
CREATE INDEX IF NOT EXISTS idx_relations_source ON public.relations(source_asset_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON public.relations(target_asset_id);
CREATE INDEX IF NOT EXISTS idx_relations_type ON public.relations(relation_type);

CREATE TABLE IF NOT EXISTS public.asset_embeddings (
  asset_id uuid PRIMARY KEY REFERENCES public.knowledge_assets(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  embedding_model text,
  embedding extensions.vector(1536),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_asset_embeddings_user_id ON public.asset_embeddings(user_id);

ALTER TABLE public.bookmarks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_embeddings ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.refresh_goal_search_index(target_user_id text DEFAULT NULL)
RETURNS TABLE (
  processed_assets integer,
  processed_entities integer,
  processed_relations integer
)
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_assets integer := 0;
  v_entities integer := 0;
  v_relations integer := 0;
  v_delta integer := 0;
BEGIN
  WITH derived AS (
    SELECT
      b.id AS bookmark_id,
      b.user_id,
      b.author_username,
      b.author_name,
      b.source_url,
      b.links,
      b.media,
      b.created_at,
      b.text_content,
      coalesce(
        nullif(b.source_url, ''),
        CASE
          WHEN cardinality(coalesce(b.links, '{}'::text[])) > 0 THEN b.links[1]
          ELSE NULL
        END
      ) AS canonical_url,
      public.extract_repo_slugs(b.text_content, b.source_url, b.links) AS repo_slugs,
      public.extract_search_terms(
        concat_ws(
          ' ',
          coalesce(b.text_content, ''),
          coalesce(array_to_string(b.links, ' '), ''),
          coalesce(b.source_url, ''),
          coalesce(b.author_username, ''),
          coalesce(b.author_name, '')
        ),
        12,
        3
      ) AS topic_terms
    FROM public.bookmarks b
    WHERE target_user_id IS NULL OR b.user_id = target_user_id
  ),
  enriched AS (
    SELECT
      d.*,
      public.infer_asset_type(d.text_content, d.repo_slugs, d.media) AS asset_type,
      public.infer_difficulty(d.text_content) AS difficulty,
      public.extract_domain(d.canonical_url) AS domain
    FROM derived d
  ),
  prepared AS (
    SELECT
      e.bookmark_id,
      e.user_id,
      e.asset_type,
      public.derive_asset_title(
        e.text_content,
        e.canonical_url,
        e.repo_slugs,
        e.author_username,
        e.author_name
      ) AS title,
      public.truncate_text(e.text_content, 220) AS summary,
      coalesce(e.topic_terms[1:8], '{}'::text[]) AS topics,
      coalesce(e.topic_terms[4:10], '{}'::text[]) AS subtopics,
      public.infer_intent_tags(e.text_content, e.asset_type) AS intent_tags,
      public.infer_required_components(
        concat_ws(
          ' ',
          coalesce(e.text_content, ''),
          coalesce(array_to_string(e.repo_slugs, ' '), ''),
          coalesce(array_to_string(e.topic_terms, ' '), '')
        )
      ) AS required_components,
      e.difficulty,
      e.canonical_url,
      e.domain,
      e.author_username,
      e.author_name,
      e.source_url,
      e.repo_slugs,
      e.created_at
    FROM enriched e
  )
  INSERT INTO public.knowledge_assets (
    bookmark_id,
    user_id,
    asset_type,
    title,
    summary,
    topics,
    subtopics,
    intent_tags,
    required_components,
    difficulty,
    canonical_url,
    domain,
    author_username,
    author_name,
    source_url,
    repo_slugs,
    created_at,
    updated_at,
    search_document
  )
  SELECT
    p.bookmark_id,
    p.user_id,
    p.asset_type,
    p.title,
    p.summary,
    p.topics,
    p.subtopics,
    p.intent_tags,
    p.required_components,
    p.difficulty,
    p.canonical_url,
    p.domain,
    p.author_username,
    p.author_name,
    p.source_url,
    p.repo_slugs,
    p.created_at,
    now(),
    public.knowledge_asset_search_doc(
      p.title,
      p.summary,
      p.topics,
      p.subtopics,
      p.intent_tags,
      p.required_components,
      p.author_username,
      p.author_name,
      p.domain,
      p.repo_slugs
    )
  FROM prepared p
  ON CONFLICT (bookmark_id) DO UPDATE
  SET
    user_id = EXCLUDED.user_id,
    asset_type = EXCLUDED.asset_type,
    title = EXCLUDED.title,
    summary = EXCLUDED.summary,
    topics = EXCLUDED.topics,
    subtopics = EXCLUDED.subtopics,
    intent_tags = EXCLUDED.intent_tags,
    required_components = EXCLUDED.required_components,
    difficulty = EXCLUDED.difficulty,
    canonical_url = EXCLUDED.canonical_url,
    domain = EXCLUDED.domain,
    author_username = EXCLUDED.author_username,
    author_name = EXCLUDED.author_name,
    source_url = EXCLUDED.source_url,
    repo_slugs = EXCLUDED.repo_slugs,
    created_at = EXCLUDED.created_at,
    updated_at = now(),
    search_document = EXCLUDED.search_document;

  GET DIAGNOSTICS v_assets = ROW_COUNT;

  DELETE FROM public.asset_entities ae
  USING public.knowledge_assets ka
  WHERE ae.asset_id = ka.id
    AND (target_user_id IS NULL OR ka.user_id = target_user_id);

  WITH scope_assets AS (
    SELECT *
    FROM public.knowledge_assets
    WHERE target_user_id IS NULL OR user_id = target_user_id
  ),
  raw_candidates AS (
    SELECT
      sa.id AS asset_id,
      sa.user_id,
      coalesce(nullif(trim(sa.author_name), ''), nullif(trim(sa.author_username), '')) AS entity_name,
      'person'::text AS entity_type
    FROM scope_assets sa
    WHERE coalesce(nullif(trim(sa.author_name), ''), nullif(trim(sa.author_username), '')) IS NOT NULL

    UNION ALL

    SELECT
      sa.id AS asset_id,
      sa.user_id,
      repo_slug AS entity_name,
      CASE
        WHEN sa.asset_type = 'repo' THEN 'tool'::text
        ELSE 'framework'::text
      END AS entity_type
    FROM scope_assets sa
    CROSS JOIN LATERAL unnest(sa.repo_slugs) AS repo_slug

    UNION ALL

    SELECT
      sa.id AS asset_id,
      sa.user_id,
      topic_term AS entity_name,
      'concept'::text AS entity_type
    FROM scope_assets sa
    CROSS JOIN LATERAL unnest(sa.topics) AS topic_term
  ),
  cleaned_candidates AS (
    SELECT
      asset_id,
      user_id,
      trim(entity_name) AS entity_name,
      public.normalize_search_text(entity_name) AS normalized_name,
      entity_type
    FROM raw_candidates
    WHERE nullif(trim(entity_name), '') IS NOT NULL
  )
  INSERT INTO public.entities (user_id, name, normalized_name, entity_type)
  SELECT DISTINCT
    cc.user_id,
    cc.entity_name,
    cc.normalized_name,
    cc.entity_type
  FROM cleaned_candidates cc
  ON CONFLICT (user_id, normalized_name, entity_type) DO UPDATE
  SET name = EXCLUDED.name;

  WITH scope_assets AS (
    SELECT *
    FROM public.knowledge_assets
    WHERE target_user_id IS NULL OR user_id = target_user_id
  ),
  raw_candidates AS (
    SELECT
      sa.id AS asset_id,
      sa.user_id,
      coalesce(nullif(trim(sa.author_name), ''), nullif(trim(sa.author_username), '')) AS entity_name,
      'person'::text AS entity_type
    FROM scope_assets sa
    WHERE coalesce(nullif(trim(sa.author_name), ''), nullif(trim(sa.author_username), '')) IS NOT NULL

    UNION ALL

    SELECT
      sa.id AS asset_id,
      sa.user_id,
      repo_slug AS entity_name,
      CASE
        WHEN sa.asset_type = 'repo' THEN 'tool'::text
        ELSE 'framework'::text
      END AS entity_type
    FROM scope_assets sa
    CROSS JOIN LATERAL unnest(sa.repo_slugs) AS repo_slug

    UNION ALL

    SELECT
      sa.id AS asset_id,
      sa.user_id,
      topic_term AS entity_name,
      'concept'::text AS entity_type
    FROM scope_assets sa
    CROSS JOIN LATERAL unnest(sa.topics) AS topic_term
  ),
  cleaned_candidates AS (
    SELECT
      asset_id,
      user_id,
      public.normalize_search_text(entity_name) AS normalized_name,
      entity_type
    FROM raw_candidates
    WHERE nullif(trim(entity_name), '') IS NOT NULL
  )
  INSERT INTO public.asset_entities (user_id, asset_id, entity_id)
  SELECT DISTINCT
    cc.user_id,
    cc.asset_id,
    e.id
  FROM cleaned_candidates cc
  JOIN public.entities e
    ON e.user_id = cc.user_id
   AND e.normalized_name = cc.normalized_name
   AND e.entity_type = cc.entity_type
  ON CONFLICT (asset_id, entity_id) DO NOTHING;

  GET DIAGNOSTICS v_entities = ROW_COUNT;

  DELETE FROM public.entities e
  WHERE (target_user_id IS NULL OR e.user_id = target_user_id)
    AND NOT EXISTS (
      SELECT 1
      FROM public.asset_entities ae
      WHERE ae.entity_id = e.id
    );

  DELETE FROM public.relations r
  WHERE target_user_id IS NULL OR r.user_id = target_user_id;

  WITH scope_assets AS (
    SELECT *
    FROM public.knowledge_assets
    WHERE target_user_id IS NULL OR user_id = target_user_id
  )
  INSERT INTO public.relations (
    user_id,
    source_asset_id,
    target_asset_id,
    relation_type,
    score,
    metadata
  )
  SELECT
    a.user_id,
    a.id,
    b.id,
    'same_author',
    4.0,
    jsonb_build_object('author', coalesce(a.author_username, a.author_name))
  FROM scope_assets a
  JOIN scope_assets b
    ON a.user_id = b.user_id
   AND a.id::text < b.id::text
   AND nullif(trim(coalesce(a.author_username, a.author_name)), '') IS NOT NULL
   AND coalesce(a.author_username, a.author_name) = coalesce(b.author_username, b.author_name);

  GET DIAGNOSTICS v_delta = ROW_COUNT;
  v_relations := v_relations + v_delta;

  WITH scope_assets AS (
    SELECT *
    FROM public.knowledge_assets
    WHERE target_user_id IS NULL OR user_id = target_user_id
  )
  INSERT INTO public.relations (
    user_id,
    source_asset_id,
    target_asset_id,
    relation_type,
    score,
    metadata
  )
  SELECT
    a.user_id,
    a.id,
    b.id,
    'same_domain',
    2.5,
    jsonb_build_object('domain', a.domain)
  FROM scope_assets a
  JOIN scope_assets b
    ON a.user_id = b.user_id
   AND a.id::text < b.id::text
   AND nullif(trim(coalesce(a.domain, '')), '') IS NOT NULL
   AND a.domain = b.domain;

  GET DIAGNOSTICS v_delta = ROW_COUNT;
  v_relations := v_relations + v_delta;

  WITH scope_assets AS (
    SELECT *
    FROM public.knowledge_assets
    WHERE target_user_id IS NULL OR user_id = target_user_id
  )
  INSERT INTO public.relations (
    user_id,
    source_asset_id,
    target_asset_id,
    relation_type,
    score,
    metadata
  )
  SELECT
    a.user_id,
    a.id,
    b.id,
    'shared_repo',
    least(5, public.array_overlap_count(a.repo_slugs, b.repo_slugs) * 2.0)::real,
    jsonb_build_object('repo_slugs', public.array_overlap_values(a.repo_slugs, b.repo_slugs))
  FROM scope_assets a
  JOIN scope_assets b
    ON a.user_id = b.user_id
   AND a.id::text < b.id::text
   AND a.repo_slugs && b.repo_slugs;

  GET DIAGNOSTICS v_delta = ROW_COUNT;
  v_relations := v_relations + v_delta;

  WITH scope_assets AS (
    SELECT *
    FROM public.knowledge_assets
    WHERE target_user_id IS NULL OR user_id = target_user_id
  )
  INSERT INTO public.relations (
    user_id,
    source_asset_id,
    target_asset_id,
    relation_type,
    score,
    metadata
  )
  SELECT
    a.user_id,
    a.id,
    b.id,
    'shared_topic',
    least(4, public.array_overlap_count(a.topics, b.topics) * 0.75)::real,
    jsonb_build_object('topics', public.array_overlap_values(a.topics, b.topics))
  FROM scope_assets a
  JOIN scope_assets b
    ON a.user_id = b.user_id
   AND a.id::text < b.id::text
   AND a.topics && b.topics;

  GET DIAGNOSTICS v_delta = ROW_COUNT;
  v_relations := v_relations + v_delta;

  WITH scope_assets AS (
    SELECT *
    FROM public.knowledge_assets
    WHERE target_user_id IS NULL OR user_id = target_user_id
  )
  INSERT INTO public.relations (
    user_id,
    source_asset_id,
    target_asset_id,
    relation_type,
    score,
    metadata
  )
  SELECT
    a.user_id,
    a.id,
    b.id,
    'same_goal_as',
    1.5,
    jsonb_build_object(
      'intent_tags', public.array_overlap_values(a.intent_tags, b.intent_tags),
      'required_components', public.array_overlap_values(a.required_components, b.required_components)
    )
  FROM scope_assets a
  JOIN scope_assets b
    ON a.user_id = b.user_id
   AND a.id::text < b.id::text
   AND (
     a.intent_tags && b.intent_tags
     OR a.required_components && b.required_components
   );

  GET DIAGNOSTICS v_delta = ROW_COUNT;
  v_relations := v_relations + v_delta;

  processed_assets := v_assets;
  processed_entities := v_entities;
  processed_relations := v_relations;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.parse_goal_query(p_goal text)
RETURNS TABLE (
  intent text,
  goal_terms text[],
  goal_components text[],
  next_steps text[]
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH parsed AS (
    SELECT
      public.detect_goal_intent(p_goal) AS intent,
      public.extract_search_terms(p_goal, 12, 3) AS goal_terms,
      public.detect_goal_components(p_goal) AS goal_components
  )
  SELECT
    parsed.intent,
    parsed.goal_terms,
    parsed.goal_components,
    CASE
      WHEN cardinality(parsed.goal_components) = 0 THEN ARRAY[
        'Start from the highest-scoring repo or tutorial, then compare adjacent results for implementation tradeoffs.'
      ]::text[]
      ELSE array_remove(
        ARRAY[
          CASE WHEN 'search' = ANY(parsed.goal_components) THEN 'Validate the retrieval path first: corpus, parsing, and ranking.' END,
          CASE WHEN 'graph' = ANY(parsed.goal_components) THEN 'Model explicit relations early so related-content and route views can reuse them.' END,
          CASE WHEN 'api' = ANY(parsed.goal_components) THEN 'Define stable endpoint contracts before tuning ranking heuristics.' END,
          CASE WHEN 'database' = ANY(parsed.goal_components) THEN 'Persist enriched assets and entity links before expanding the UI surface.' END,
          CASE WHEN 'llm' = ANY(parsed.goal_components) THEN 'Lock the embedding model and dimensionality before storing vectors.' END
        ]::text[],
        NULL
      )
    END AS next_steps
  FROM parsed;
$$;

CREATE OR REPLACE FUNCTION public.search_goal_assets(
  p_goal text,
  p_user_id text DEFAULT NULL,
  p_author text DEFAULT NULL,
  p_domain text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  asset_id uuid,
  bookmark_id text,
  user_id text,
  tweet_id text,
  text_content text,
  author_username text,
  author_name text,
  created_at timestamptz,
  links text[],
  media text[],
  source_url text,
  source_domain text,
  asset_type text,
  title text,
  summary text,
  topics text[],
  subtopics text[],
  intent_tags text[],
  required_components text[],
  difficulty text,
  score real,
  text_score real,
  topic_score real,
  component_score real,
  intent_score real,
  relation_score real,
  freshness_score real,
  why_this_result text[],
  total_count bigint
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH goal_input AS (
    SELECT
      nullif(btrim(p_goal), '') AS goal_text,
      public.detect_goal_intent(p_goal) AS goal_intent,
      public.extract_search_terms(p_goal, 12, 3) AS goal_terms,
      public.detect_goal_components(p_goal) AS goal_components,
      CASE
        WHEN nullif(btrim(p_goal), '') IS NULL THEN NULL::tsquery
        ELSE websearch_to_tsquery('simple', btrim(p_goal))
      END AS query_ts,
      greatest(coalesce(p_limit, 20), 1) AS normalized_limit,
      greatest(coalesce(p_offset, 0), 0) AS normalized_offset,
      nullif(lower(btrim(coalesce(p_author, ''))), '') AS normalized_author,
      nullif(lower(btrim(coalesce(p_domain, ''))), '') AS normalized_domain
  ),
  relation_counts AS (
    SELECT
      user_id,
      asset_id,
      count(*)::integer AS relation_count
    FROM (
      SELECT user_id, source_asset_id AS asset_id FROM public.relations
      UNION ALL
      SELECT user_id, target_asset_id AS asset_id FROM public.relations
    ) rel
    GROUP BY user_id, asset_id
  ),
  entity_matches AS (
    SELECT
      ae.asset_id,
      count(*)::integer AS matched_entities
    FROM goal_input gi
    JOIN public.entities e
      ON e.normalized_name = ANY(gi.goal_terms)
    JOIN public.asset_entities ae
      ON ae.entity_id = e.id
    GROUP BY ae.asset_id
  ),
  base AS (
    SELECT
      ka.id AS asset_id,
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
      ka.domain AS source_domain,
      ka.asset_type,
      ka.title,
      ka.summary,
      ka.topics,
      ka.subtopics,
      ka.intent_tags,
      ka.required_components,
      ka.difficulty,
      gi.goal_intent,
      gi.goal_terms,
      gi.goal_components,
      gi.query_ts,
      gi.normalized_limit,
      gi.normalized_offset,
      public.array_overlap_values(ka.topics, gi.goal_terms) AS matched_topics,
      public.array_overlap_values(ka.required_components, gi.goal_components) AS matched_components,
      coalesce(rc.relation_count, 0) AS relation_count,
      coalesce(em.matched_entities, 0) AS entity_match_count,
      CASE
        WHEN gi.query_ts IS NULL THEN 0::real
        ELSE (ts_rank_cd(ka.search_document, gi.query_ts) * 2.4)::real
      END AS text_score,
      (
        public.array_overlap_count(ka.topics, gi.goal_terms) * 0.45
        + public.array_overlap_count(ka.subtopics, gi.goal_terms) * 0.20
        + coalesce(em.matched_entities, 0) * 0.25
      )::real AS topic_score,
      (public.array_overlap_count(ka.required_components, gi.goal_components) * 1.10)::real AS component_score,
      CASE
        WHEN gi.goal_intent = ANY(ka.intent_tags) THEN 0.90::real
        ELSE 0::real
      END AS intent_score,
      least(coalesce(rc.relation_count, 0), 6) * 0.12::real AS relation_score,
      CASE
        WHEN ka.created_at IS NULL THEN 0::real
        WHEN ka.created_at >= now() - interval '30 days' THEN 0.25::real
        WHEN ka.created_at >= now() - interval '90 days' THEN 0.10::real
        ELSE 0::real
      END AS freshness_score,
      CASE
        WHEN gi.goal_intent = 'build' AND ka.asset_type IN ('repo', 'tool', 'tutorial') THEN 0.80::real
        WHEN gi.goal_intent = 'learn' AND ka.asset_type IN ('tutorial', 'thread', 'paper', 'video') THEN 0.70::real
        WHEN gi.goal_intent = 'debug' AND ka.asset_type IN ('thread', 'tutorial', 'tool') THEN 0.60::real
        WHEN gi.goal_intent = 'compare' AND ka.asset_type IN ('tool', 'repo', 'paper') THEN 0.55::real
        WHEN gi.goal_intent = 'integrate' AND ka.asset_type IN ('tool', 'repo', 'tutorial') THEN 0.75::real
        ELSE 0::real
      END AS asset_type_bonus
    FROM public.knowledge_assets ka
    JOIN public.bookmarks b
      ON b.id = ka.bookmark_id
    CROSS JOIN goal_input gi
    LEFT JOIN relation_counts rc
      ON rc.user_id = ka.user_id
     AND rc.asset_id = ka.id
    LEFT JOIN entity_matches em
      ON em.asset_id = ka.id
    WHERE (p_user_id IS NULL OR ka.user_id = p_user_id)
      AND (p_from IS NULL OR ka.created_at >= p_from)
      AND (p_to IS NULL OR ka.created_at <= p_to)
      AND (
        gi.normalized_author IS NULL
        OR lower(coalesce(ka.author_username, '')) LIKE '%' || gi.normalized_author || '%'
        OR lower(coalesce(ka.author_name, '')) LIKE '%' || gi.normalized_author || '%'
      )
      AND (
        gi.normalized_domain IS NULL
        OR lower(coalesce(ka.domain, '')) = gi.normalized_domain
        OR lower(coalesce(ka.source_url, '')) LIKE '%' || gi.normalized_domain || '%'
      )
  ),
  ranked AS (
    SELECT
      base.*,
      (
        base.text_score
        + base.topic_score
        + base.component_score
        + base.intent_score
        + base.relation_score
        + base.freshness_score
        + base.asset_type_bonus
      )::real AS combined_score,
      array_remove(
        ARRAY[
          CASE WHEN base.text_score > 0 THEN 'fts' END,
          CASE WHEN cardinality(base.matched_topics) > 0 THEN 'topics:' || array_to_string(base.matched_topics, ', ') END,
          CASE WHEN cardinality(base.matched_components) > 0 THEN 'components:' || array_to_string(base.matched_components, ', ') END,
          CASE WHEN base.goal_intent = ANY(base.intent_tags) THEN 'intent:' || base.goal_intent END,
          CASE WHEN base.asset_type_bonus > 0 THEN 'asset_type:' || base.asset_type END,
          CASE WHEN base.relation_count > 0 THEN 'graph:' || least(base.relation_count, 10)::text || '_links' END
        ]::text[],
        NULL
      ) AS why_this_result
    FROM base
    WHERE
      base.text_score > 0
      OR base.topic_score > 0
      OR base.component_score > 0
      OR base.intent_score > 0
      OR base.asset_type_bonus > 0
  ),
  ordered AS (
    SELECT
      ranked.*,
      count(*) OVER () AS matched_total
    FROM ranked
    ORDER BY ranked.combined_score DESC, ranked.created_at DESC NULLS LAST
  )
  SELECT
    ordered.asset_id,
    ordered.bookmark_id,
    ordered.user_id,
    ordered.tweet_id,
    ordered.text_content,
    ordered.author_username,
    ordered.author_name,
    ordered.created_at,
    ordered.links,
    ordered.media,
    ordered.source_url,
    ordered.source_domain,
    ordered.asset_type,
    ordered.title,
    ordered.summary,
    ordered.topics,
    ordered.subtopics,
    ordered.intent_tags,
    ordered.required_components,
    ordered.difficulty,
    ordered.combined_score AS score,
    ordered.text_score,
    ordered.topic_score,
    ordered.component_score,
    ordered.intent_score,
    ordered.relation_score,
    ordered.freshness_score,
    ordered.why_this_result,
    ordered.matched_total AS total_count
  FROM ordered
  OFFSET (SELECT normalized_offset FROM goal_input)
  LIMIT (SELECT normalized_limit FROM goal_input);
$$;

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
      public.bookmarks_fts_simple_doc(b.text_content, b.author_username, b.author_name) AS document_vector
    FROM public.bookmarks b
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

SELECT *
FROM public.refresh_goal_search_index(NULL);
