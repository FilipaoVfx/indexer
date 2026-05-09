-- Step metadata: descriptions, typical inputs/outputs per pipeline step.
-- Used by the API to enrich the steps[] array in goal search responses.

CREATE TABLE IF NOT EXISTS public.goal_step_metadata (
  step_name   text PRIMARY KEY,
  label       text NOT NULL,
  description text NOT NULL,
  inputs      text[] NOT NULL DEFAULT '{}',
  outputs     text[] NOT NULL DEFAULT '{}',
  icon        text NOT NULL DEFAULT 'widgets',
  sort_order  integer NOT NULL DEFAULT 0
);

INSERT INTO public.goal_step_metadata (step_name, label, description, inputs, outputs, icon, sort_order)
VALUES
  ('data_extraction',
   'Data Extraction',
   'Collect raw data from external sources: APIs, web scraping, file imports, or third-party services.',
   ARRAY['URLs', 'API credentials', 'target selectors'],
   ARRAY['raw data (JSON/HTML)', 'extracted records'],
   'pest_control', 1),

  ('data_enrichment',
   'Data Enrichment',
   'Clean, normalize, and augment raw data with additional metadata, tags, or derived fields.',
   ARRAY['raw data', 'extracted records'],
   ARRAY['enriched records', 'normalized data', 'tags/keywords'],
   'auto_fix_high', 2),

  ('storage',
   'Storage',
   'Persist enriched data in a database or file system for reliable retrieval and querying.',
   ARRAY['enriched records', 'normalized data'],
   ARRAY['stored records', 'database tables', 'indexed data'],
   'database', 3),

  ('api_layer',
   'API Layer',
   'Expose stored data through HTTP endpoints for frontend consumption or third-party integrations.',
   ARRAY['stored records', 'database connection'],
   ARRAY['REST/GraphQL endpoints', 'JSON responses'],
   'api', 4),

  ('search_layer',
   'Search Layer',
   'Enable full-text search, fuzzy matching, and ranked retrieval over indexed content.',
   ARRAY['indexed data', 'search queries'],
   ARRAY['ranked results', 'search suggestions', 'highlights'],
   'search', 5),

  ('ai_reasoning',
   'AI / LLM',
   'Apply language models for classification, summarization, embedding generation, or conversational interfaces.',
   ARRAY['text content', 'prompts', 'context'],
   ARRAY['classifications', 'summaries', 'embeddings', 'generated text'],
   'psychology', 6),

  ('workflow',
   'Workflow / Automation',
   'Orchestrate multi-step processes: scheduling, triggers, retries, and pipeline coordination.',
   ARRAY['triggers/events', 'step definitions'],
   ARRAY['executed tasks', 'status reports', 'notifications'],
   'conveyor_belt', 7),

  ('outreach',
   'Outreach / Emails',
   'Send personalized communications: email campaigns, notifications, or messaging integrations.',
   ARRAY['contact lists', 'templates', 'enriched data'],
   ARRAY['sent messages', 'delivery reports', 'engagement metrics'],
   'mail', 8),

  ('visualization',
   'Dashboard / Visualization',
   'Present data through interactive dashboards, charts, and user interfaces.',
   ARRAY['API responses', 'aggregated data'],
   ARRAY['rendered UI', 'charts', 'interactive dashboards'],
   'analytics', 9),

  ('auth_layer',
   'Authentication',
   'Manage user identity, access control, and session management.',
   ARRAY['user credentials', 'OAuth tokens'],
   ARRAY['authenticated sessions', 'JWT tokens', 'user profiles'],
   'lock', 10),

  ('deployment',
   'Deployment',
   'Package and deploy the system to production: CI/CD, containers, hosting, and monitoring.',
   ARRAY['built artifacts', 'configuration'],
   ARRAY['running services', 'health endpoints', 'logs'],
   'rocket_launch', 11)
ON CONFLICT (step_name) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  inputs = EXCLUDED.inputs,
  outputs = EXCLUDED.outputs,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order;

-- Helper function: fetch metadata for a list of steps
CREATE OR REPLACE FUNCTION public.get_step_metadata(p_steps text[])
RETURNS TABLE (
  step_name   text,
  label       text,
  description text,
  inputs      text[],
  outputs     text[],
  icon        text,
  sort_order  integer
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT m.step_name, m.label, m.description, m.inputs, m.outputs, m.icon, m.sort_order
  FROM public.goal_step_metadata m
  WHERE m.step_name = ANY(p_steps)
  ORDER BY m.sort_order;
$$;
