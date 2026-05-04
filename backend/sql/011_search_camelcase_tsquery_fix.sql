-- Step 1: Run this first
CREATE OR REPLACE FUNCTION public.split_camelcase_for_tsquery(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT lower(
    regexp_replace(
      regexp_replace(
        coalesce(p_text, ''),
        '([[:upper:]]+)([[:upper:]][[:lower:]])',
        '\1 \2',
        'g'
      ),
      '([[:lower:][:digit:]])([[:upper:]])',
      '\1 \2',
      'g'
    )
  );
$$;
