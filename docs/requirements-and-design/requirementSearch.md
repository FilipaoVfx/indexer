# Search Requirements for Indexbook

## Version

- Version: 1.1
- Date: 2026-04-12
- Status: working draft aligned to current repository

## 1. Purpose

Define the functional, technical, and evolutionary requirements for the internal search engine of `indexbook`.

This document replaces a generic draft and aligns the search strategy with the codebase that exists today:

- `extension/` extracts bookmarks from X
- `backend/` receives, normalizes, stores, and exposes search
- Supabase/Postgres is the current storage layer

The goal is not only to search by keyword, but to evolve the product into a private knowledge retrieval system with:

- strong lexical search
- hybrid retrieval
- semantic enrichment
- explainable ranking
- graph-based exploration
- observability for relevance tuning

## 2. Current State

## 2.1 What exists today

- Bookmark ingestion from a browser extension
- Batch upsert into Supabase
- A basic search path implemented in `backend/src/store.js`
- Filtering by `userId`, `author`, `from`, `to`
- Result ordering by `created_at desc`

## 2.2 Current search limitations

The current implementation searches using `ilike` over:

- `text_content`
- `author_username`
- `author_name`

This is useful for MVP validation, but it has important limitations:

- no true relevance ranking
- no field weighting
- no phrase handling
- no query parser
- no semantic similarity
- no explainability
- no dedup-aware ranking
- no graph relationships

## 2.3 Important repository observation

The SQL schema already creates a full-text index:

- `backend/sql/001_bookmarks_schema.sql`

However, the backend search path is not using Postgres full-text search yet.

That makes the first practical milestone very clear:

1. replace `ilike`-only retrieval with weighted full-text search
2. keep filters and pagination
3. add ranking explanations

## 3. Product Goal

Build an internal search engine that behaves like a personal retrieval system, not just a text filter over a bookmarks table.

The user should be able to:

- find exact matches quickly
- find relevant results even with imperfect wording
- filter by structured metadata
- discover related items
- inspect why a result ranked highly
- navigate related authors, domains, links, and themes

## 4. Scope

## 4.1 In scope

- search over bookmarks imported from X
- metadata-aware filtering
- lexical ranking
- hybrid lexical + semantic retrieval
- query parsing and query rewriting
- dedup-aware ranking
- graph-style relationship exploration
- search analytics

## 4.2 Out of scope for the first milestone

- real-time collaborative search
- public search indexing
- complex multi-tenant enterprise auth
- large-scale distributed search clusters

## 5. Guiding Principles

- Start simple, but design for evolution.
- Separate retrieval, ranking, reranking, and enrichment.
- Prefer explainable signals before opaque model-heavy logic.
- Keep the search pipeline observable from day one.
- Use async processing for expensive enrichment and embedding generation.
- Preserve user ownership and privacy across every stage.

## 6. Search Roadmap

## Phase 1: Strong lexical search

Objective:

- move from `ilike` search to weighted Postgres full-text search

Includes:

- `tsvector` based indexing
- weighted fields
- snippets and highlights
- filters
- stable query syntax
- search logs

## Phase 2: Hybrid retrieval

Objective:

- combine lexical retrieval with embeddings

Includes:

- pgvector
- embedding generation pipeline
- top-k semantic retrieval
- result fusion
- configurable weights

## Phase 3: Reranking and explainability

Objective:

- improve top result quality without paying full cost on the whole corpus

Includes:

- top-N reranking
- query intent classification
- better score explanations
- dedup and diversity controls

## Phase 4: Graph-aware exploration

Objective:

- turn search into exploration

Includes:

- relations between bookmarks, authors, domains, links, and inferred topics
- related results
- neighborhood exploration
- cluster and community discovery

## 7. Functional Requirements

## 7.1 Ingestion

### RF-ING-001

The system must ingest bookmarks with at least:

- internal id
- user id
- source type
- source external id
- text content
- timestamp
- optional metadata

### RF-ING-002

The system must support:

- batch ingestion
- manual sync
- incremental sync
- reprocessing of failed items

### RF-ING-003

The system must preserve enough raw metadata to support future reindexing without re-scraping.

## 7.2 Normalization

### RF-NOR-001

The system must normalize:

- whitespace
- casing strategy where appropriate
- URLs
- hashtags
- mentions
- repeated symbols

### RF-NOR-002

The system should derive:

- normalized text
- source domain
- outbound links
- detected language
- extracted entities
- inferred topics

### RF-NOR-003

The system must keep both:

- normalized representation
- original source payload or enough raw fields to reconstruct it

## 7.3 Deduplication

### RF-DED-001

The system must prevent exact duplicates using:

- `(user_id, tweet_id)`
- content hash when available

### RF-DED-002

The system should support near-duplicate detection using:

- normalized text similarity
- link overlap
- embedding similarity

### RF-DED-003

The system must penalize duplicates in ranking before deleting them.

## 7.4 Indexing

### RF-IDX-001

The system must create and maintain a lexical search index.

### RF-IDX-002

The system must support incremental indexing for new and updated records.

### RF-IDX-003

The system should version indexing pipelines so ranking changes can be audited.

### RF-IDX-004

The system should support embedding generation outside the user request path.

## 7.5 Basic search

### RF-SRC-001

The user must be able to run free-text searches.

### RF-SRC-002

The system must return results ordered by relevance, not only by recency.

### RF-SRC-003

The system must support pagination.

### RF-SRC-004

The system should return snippets or highlighted matches.

## 7.6 Advanced search

### RF-ADV-001

The system must support filters by:

- date range
- author
- domain
- source type
- tags
- language

### RF-ADV-002

The system must define a documented search syntax with at least:

- quoted phrases
- excluded terms using `-term`
- field filters such as `author:`, `domain:`, `from:`, `to:`
- boolean `OR`

### RF-ADV-003

The parser should be tolerant of small syntax mistakes.

### RF-ADV-004

The system should expose the parsed interpretation of the query for debugging.

## 7.7 Hybrid search

### RF-HYB-001

The system must combine lexical and semantic retrieval once embeddings are enabled.

### RF-HYB-002

The system should support at least one robust fusion strategy, preferably:

- reciprocal rank fusion

Optional future strategies:

- weighted sum
- learned scoring
- reranking after fusion

### RF-HYB-003

The system must allow configurable weights by signal.

### RF-HYB-004

The system must expose why a result was returned, including the signals that contributed most.

## 7.8 Graph-aware exploration

### RF-GRF-001

The system should model relationships such as:

- bookmark -> author
- bookmark -> domain
- bookmark -> link
- bookmark -> inferred topic
- bookmark -> similar bookmark
- author -> domain
- author -> topic

### RF-GRF-002

The user should be able to navigate from a result to related nodes.

### RF-GRF-003

The system should support graph-based retrieval such as:

- more from this author
- same domain, different topic
- similar bookmarks
- items connected through shared entities

## 7.9 Enrichment

### RF-ENR-001

The system should support automatic tagging.

### RF-ENR-002

The system should support topic inference.

### RF-ENR-003

The system should support short summaries for result previews.

### RF-ENR-004

The system should track confidence for inferred metadata.

## 7.10 Observability

### RF-OBS-001

The system must log search requests.

### RF-OBS-002

The log should include:

- raw query
- parsed query
- strategy used
- latency
- result count
- top result diagnostics
- pipeline version

### RF-OBS-003

The system should support later analysis of:

- zero-result queries
- low-recall queries
- slow queries
- high-abandonment queries

## 8. Non-Functional Requirements

## 8.1 Performance

### RNF-PER-001

Simple lexical search should feel fast for an individual user corpus.

### RNF-PER-002

Hybrid search may be slower than lexical search, but must remain controlled and paginated.

### RNF-PER-003

Embedding generation must stay off the critical request path whenever possible.

## 8.2 Maintainability

### RNF-MAN-001

Retrieval, ranking, parsing, enrichment, and graph logic must be separable modules.

### RNF-MAN-002

Ranking weights must not be hidden in opaque hardcoded logic.

### RNF-MAN-003

Feature flags should be available for experimenting with ranking behavior.

## 8.3 Security

### RNF-SEC-001

The system must scope data by user ownership.

### RNF-SEC-002

Secrets must remain server-side only.

### RNF-SEC-003

Search logs must not leak secrets or private tokens.

## 8.4 Reliability

### RNF-REL-001

Search must degrade gracefully if embeddings or enrichment are unavailable.

### RNF-REL-002

A lexical-only fallback must remain available.

## 9. Search Query Language

The initial query language should support:

- `javascript`
- `"exact phrase"`
- `author:elon`
- `domain:github.com`
- `from:2026-01-01`
- `to:2026-04-01`
- `rag OR embeddings`
- `postgres -mysql`

Rules:

- whitespace separates terms
- quoted phrases must stay intact
- filters should be parsed before free-text expansion
- invalid filters should not crash the query
- the backend should return the parsed query when debug mode is enabled

## 10. Ranking Model

## 10.1 Phase 1 lexical score

Signals:

- text match in `text_content`
- author match
- exact phrase match
- recency boost
- exact keyword overlap

Recommended field weights:

- author exact match: very high
- author partial match: medium
- text content lexical score: high
- domain match: medium
- recency: low to medium

## 10.2 Phase 2 hybrid score

Signals:

- lexical rank
- semantic similarity rank
- freshness
- duplicate penalty

Recommended fusion:

- reciprocal rank fusion as default

## 10.3 Phase 3 reranking

Apply reranking only to top-N candidates.

Signals may include:

- query intent alignment
- novelty and diversity
- entity overlap
- theme coherence
- graph proximity

## 11. Recommended Data Model Evolution

## 11.1 Current table

Current table:

- `bookmarks`

Important current columns:

- `id`
- `user_id`
- `tweet_id`
- `text_content`
- `author_username`
- `author_name`
- `links`
- `source_url`
- `created_at`

## 11.2 Recommended additions to `bookmarks`

Add when the search pipeline matures:

- `normalized_text text`
- `language text`
- `source_domain text`
- `content_hash text`
- `search_vector tsvector`
- `metadata jsonb`

Optional:

- `topics text[]`
- `entities jsonb`
- `is_duplicate boolean`
- `duplicate_of text`

## 11.3 Recommended supporting tables

### `bookmark_embeddings`

Purpose:

- store vector embeddings per bookmark or per chunk

Suggested columns:

- `id`
- `bookmark_id`
- `embedding`
- `embedding_model`
- `pipeline_version`
- `created_at`

### `bookmark_relations`

Purpose:

- store graph-like edges

Suggested columns:

- `id`
- `user_id`
- `from_type`
- `from_id`
- `to_type`
- `to_id`
- `relation_type`
- `weight`
- `confidence`
- `metadata`
- `created_at`

### `query_logs`

Purpose:

- relevance tuning and observability

Suggested columns:

- `id`
- `user_id`
- `raw_query`
- `parsed_query`
- `strategy`
- `latency_ms`
- `results_count`
- `metadata`
- `created_at`

## 12. API Evolution

## 12.1 Current search API

Current behavior is effectively:

- free-text `q`
- `author`
- `from`
- `to`
- `limit`
- `offset`

## 12.2 Recommended search API shape

Example:

```http
GET /api/bookmarks/search?q=vector+database&author:alice&from=2026-01-01&limit=20&strategy=hybrid
```

Recommended normalized request structure on the server:

```json
{
  "rawQuery": "vector database author:alice from:2026-01-01",
  "parsedQuery": {
    "terms": ["vector", "database"],
    "phrases": [],
    "exclude": [],
    "filters": {
      "author": "alice",
      "from": "2026-01-01"
    }
  },
  "strategy": "lexical",
  "limit": 20,
  "offset": 0,
  "debug": false
}
```

Recommended response shape:

```json
{
  "total": 123,
  "strategy": "lexical",
  "latencyMs": 38,
  "parsedQuery": {
    "terms": ["vector", "database"],
    "phrases": [],
    "exclude": [],
    "filters": {
      "author": "alice",
      "from": "2026-01-01"
    }
  },
  "items": [
    {
      "id": "bookmark_1",
      "score": 0.82,
      "scoreBreakdown": {
        "lexical": 0.74,
        "authorBoost": 0.08
      }
    }
  ]
}
```

## 13. Acceptance Criteria by Phase

## Phase 1

- Search no longer depends only on `ilike`
- Results are ordered by lexical relevance
- Filters still work
- Snippets are available
- Search logs exist

## Phase 2

- Semantic retrieval can be enabled per query or feature flag
- Fusion of lexical and vector retrieval is traceable
- Embeddings are generated asynchronously

## Phase 3

- Reranking applies only to top-N
- Score explanations are visible in debug mode
- Duplicate-heavy result sets are reduced

## Phase 4

- A result can expose related bookmarks
- Relations can be computed from shared author, domain, link, topic, or similarity
- The graph layer improves exploration without replacing core retrieval

## 14. Main Technical Risks

### RT-001

Trying to build lexical, semantic, graph, and UI exploration all at once.

Mitigation:

- phase-based delivery
- stable interfaces between modules

### RT-002

Overweighting semantic similarity and hurting precision.

Mitigation:

- lexical-first baseline
- measurable experiments
- debug score breakdowns

### RT-003

Embedding and reranking costs growing too early.

Mitigation:

- async embeddings
- top-N reranking
- feature flags

### RT-004

Graph logic becoming expensive before it proves value.

Mitigation:

- start with logical relations in Postgres
- only move to a dedicated graph engine if needed

## 15. Immediate Engineering Recommendation

The next implementation step should be:

1. upgrade `backend/src/store.js` from `ilike` search to Postgres full-text search
2. add weighted field ranking
3. add parsed filters and stable query syntax
4. add query logging
5. keep the API backward compatible where possible

That sequence gives the project a much stronger baseline before embeddings or graph logic are introduced.

## 16. Conclusion

`indexbook` already has the foundations of a useful private search product:

- a real ingestion source
- a persistent backend
- a relational store
- an initial search endpoint

What it needs now is not more generic ambition, but a disciplined evolution:

- first lexical relevance
- then hybrid retrieval
- then reranking
- then graph-aware exploration

If implemented in that order, the system can grow from a bookmark search MVP into a robust internal search and knowledge retrieval platform.
