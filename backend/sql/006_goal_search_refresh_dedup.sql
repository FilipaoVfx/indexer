CREATE OR REPLACE FUNCTION public.is_internal_x_domain(p_url text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(public.extract_domain(p_url), '') = ANY (
    ARRAY['x.com', 'twitter.com']::text[]
  );
$$;

CREATE OR REPLACE FUNCTION public.pick_bookmark_canonical_url(
  p_source_url text,
  p_links text[],
  p_first_comment_links text[] DEFAULT '{}'::text[]
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH candidates AS (
    SELECT 1 AS priority, ord::integer AS ord, nullif(trim(url), '') AS url
    FROM unnest(coalesce(p_first_comment_links, '{}'::text[])) WITH ORDINALITY AS t(url, ord)

    UNION ALL

    SELECT 2 AS priority, ord::integer AS ord, nullif(trim(url), '') AS url
    FROM unnest(coalesce(p_links, '{}'::text[])) WITH ORDINALITY AS t(url, ord)

    UNION ALL

    SELECT 3 AS priority, 1 AS ord, nullif(trim(coalesce(p_source_url, '')), '') AS url
  )
  SELECT coalesce(
    (
      SELECT c.url
      FROM candidates c
      WHERE c.url IS NOT NULL
        AND public.extract_domain(c.url) IS NOT NULL
        AND NOT public.is_internal_x_domain(c.url)
      ORDER BY c.priority, c.ord
      LIMIT 1
    ),
    (
      SELECT c.url
      FROM candidates c
      WHERE c.url IS NOT NULL
        AND public.extract_domain(c.url) IS NOT NULL
      ORDER BY c.priority, c.ord
      LIMIT 1
    ),
    nullif(trim(coalesce(p_source_url, '')), '')
  );
$$;

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
      b.first_comment_links,
      b.media,
      b.created_at,
      b.text_content,
      public.pick_bookmark_canonical_url(
        b.source_url,
        b.links,
        b.first_comment_links
      ) AS canonical_url,
      public.extract_repo_slugs(
        b.text_content,
        public.pick_bookmark_canonical_url(
          b.source_url,
          b.links,
          b.first_comment_links
        ),
        coalesce(b.links, '{}'::text[]) || coalesce(b.first_comment_links, '{}'::text[])
      ) AS repo_slugs,
      public.extract_search_terms(
        concat_ws(
          ' ',
          coalesce(b.text_content, ''),
          coalesce(array_to_string(b.links, ' '), ''),
          coalesce(array_to_string(b.first_comment_links, ' '), ''),
          coalesce(
            public.pick_bookmark_canonical_url(
              b.source_url,
              b.links,
              b.first_comment_links
            ),
            ''
          ),
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
  ),
  deduped_candidates AS (
    SELECT
      cc.user_id,
      cc.normalized_name,
      cc.entity_type,
      (array_agg(cc.entity_name ORDER BY char_length(cc.entity_name) DESC, cc.entity_name))[1] AS entity_name
    FROM cleaned_candidates cc
    WHERE nullif(cc.normalized_name, '') IS NOT NULL
    GROUP BY
      cc.user_id,
      cc.normalized_name,
      cc.entity_type
  )
  INSERT INTO public.entities (user_id, name, normalized_name, entity_type)
  SELECT
    dc.user_id,
    dc.entity_name,
    dc.normalized_name,
    dc.entity_type
  FROM deduped_candidates dc
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
      AND nullif(public.normalize_search_text(entity_name), '') IS NOT NULL
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
