-- 015_rag_sync_state.sql
-- Tabla de control de sincronización RAG (Pinecone ↔ Supabase).
-- Rastrea qué chunks han sido indexados en Pinecone para detectar
-- cambios y permitir re-sincronización incremental.

CREATE TABLE IF NOT EXISTS public.rag_sync_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL CHECK (source_type IN ('bookmark', 'readme')),
  source_id TEXT NOT NULL,
  chunk_index INT NOT NULL DEFAULT 0,
  pinecone_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_type, source_id, chunk_index)
);

-- Índices para queries de sincronización
CREATE INDEX IF NOT EXISTS idx_rag_sync_state_source
  ON public.rag_sync_state(source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_rag_sync_state_synced
  ON public.rag_sync_state(synced_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_sync_state_pinecone
  ON public.rag_sync_state(pinecone_id);

-- Tabla de log de queries RAG (opcional, para métricas)
CREATE TABLE IF NOT EXISTS public.rag_queries_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query TEXT NOT NULL,
  interface TEXT NOT NULL CHECK (interface IN ('cli', 'telegram', 'api')),
  user_id TEXT,
  results_count INT DEFAULT 0,
  latency_ms INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rag_queries_log_created
  ON public.rag_queries_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_queries_log_interface
  ON public.rag_queries_log(interface, created_at DESC);

-- RLS: solo service role puede acceder
ALTER TABLE public.rag_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_queries_log ENABLE ROW LEVEL SECURITY;
