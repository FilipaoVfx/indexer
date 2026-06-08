# 🧠 PRD — X Bookmarks Indexer (Scraping-based MVP)

## 1. Overview

Build a system that allows users to **extract, store, and search their X (Twitter) bookmarks** without using the official API, leveraging browser automation (extension) or headless scraping.

The product will act as a **personal knowledge index** powered by bookmarks.

---

## 2. Problem

Users save valuable content in X bookmarks, but:
- There is no advanced search
- No semantic retrieval
- No cross-platform integration
- Data is locked inside X

---

## 3. Solution

Create a system that:
1. Extracts bookmarks via scraping (browser extension or headless)
2. Stores them in a structured database
3. Indexes them for search (keyword + semantic)
4. Provides a custom UI for retrieval

---

## 4. Target Users

- Developers
- Researchers
- Content curators
- Power users of X

---

## 5. Core Features (MVP)

### 5.1 Bookmark Extraction
- Navigate to `https://x.com/i/bookmarks`
- Infinite scroll automation
- Extract:
  - tweet_id
  - text
  - author
  - timestamp
  - links
  - media

---

### 5.2 Sync Engine
- Manual trigger: "Sync bookmarks"
- Avoid duplicates
- Incremental updates

---

### 5.3 Storage
- Store bookmarks in Supabase/Postgres

---

### 5.4 Search UI
- Full-text search
- Filters:
  - author
  - date
  - keyword

---

### 5.5 Optional (Phase 2)
- Embeddings (semantic search)
- Auto-tagging
- Summaries

---

## 6. UX Flow

1. User installs extension
2. Logs into X normally
3. Opens extension → clicks "Sync"
4. Script runs → extracts bookmarks
5. Data sent to backend
6. User accesses search dashboard

---

## 7. Success Metrics

- Time to first sync < 30s
- % of bookmarks successfully extracted > 95%
- Search latency < 200ms
- User retention (daily usage)

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| X changes DOM | Abstract selectors |
| Rate limiting | Throttle scroll |
| Account blocking | Human-like delays |
| Large datasets | Pagination + batching |

---

## 9. Roadmap

### Phase 1 (MVP)
- Extension scraping
- Basic storage
- Basic search

### Phase 2
- Semantic search
- Multi-source ingestion

### Phase 3
- AI assistant over bookmarks

---

## 10. Product Vision

Transform bookmarks into a **searchable personal knowledge graph**.
