# ⚙️ SRS — X Bookmarks Scraper System

## 1. System Architecture

### Components

1. Browser Extension (Frontend + Scraper)
2. Backend API (Node / Edge)
3. Database (Supabase/Postgres)
4. Search Layer (Postgres FTS / Vector DB)

---

## 2. Functional Requirements

### 2.1 Scraper Engine

- Navigate to:
  https://x.com/i/bookmarks

- Execute:
  - Auto scroll
  - Detect tweet nodes
  - Extract structured data

#### Data Model Extracted:

```json
{
  "tweet_id": "string",
  "text": "string",
  "author_name": "string",
  "author_username": "string",
  "created_at": "timestamp",
  "links": [],
  "media": []
}

2.2 DOM Extraction Logic

Selectors (example, must be dynamic):

Tweet container:
[data-testid="tweet"]
Text:
[data-testid="tweetText"]
Author:
[data-testid="User-Name"]
Timestamp:
time
2.3 Infinite Scroll Algorithm
while (new content detected):
    scroll to bottom
    wait random(1s - 3s)
    extract tweets
    store unique tweets
    stop if no new tweets after N iterations
2.4 Deduplication

Constraint:

unique (user_id, tweet_id)
2.5 Data Transport

Extension → Backend via REST:

POST /api/bookmarks/batch

{
  "bookmarks": [...]
}
2.6 Backend Processing
Validate payload
Normalize data
Store in DB
Generate embeddings (optional)
2.7 Database Schema
create table bookmarks (
  id uuid primary key,
  user_id text,
  tweet_id text,
  text_content text,
  author_username text,
  author_name text,
  created_at timestamp,
  links jsonb,
  media jsonb,
  inserted_at timestamp default now(),
  unique(user_id, tweet_id)
);
3. Non-Functional Requirements
3.1 Performance
Scraping must not exceed:
1 request per second equivalent
Batch size:
20–50 tweets
3.2 Scalability
Handle 10k+ bookmarks per user
Use pagination in backend
3.3 Reliability
Retry failed batches
Local buffer before sending
3.4 Security
No storage of X credentials
Use session from browser
HTTPS only
4. Extension Architecture
Files
/extension
  ├── manifest.json
  ├── content.js
  ├── background.js
  ├── popup.html
  ├── popup.js
content.js
Injected into X bookmarks page
Runs scraper logic
background.js
Handles API communication
Queue management
popup.js
UI trigger (Sync button)
5. Error Handling
Error	Action
DOM not found	Retry
Network error	Retry batch
Duplicate	Ignore
Scroll stuck	Break loop
6. Future Extensions
Multi-platform ingestion:
Reddit saved
Notion
Clipboard logs
AI layer:
clustering
summarization
recommendation
7. Deployment
Backend
Cloudflare Workers / Node server
DB
Supabase
Extension
Chrome Web Store (private beta)
8. Monitoring
Logs:
sync success rate
extraction errors
Metrics:
bookmarks per user
sync duration
9. Known Constraints
Depends on X DOM structure
May break with UI updates
Requires active session in browser
10. Conclusion

This system prioritizes:

zero API dependency
rapid MVP deployment
scalable evolution to multi-source indexing