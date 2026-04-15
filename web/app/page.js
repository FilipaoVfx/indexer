import { searchBookmarks } from "@/lib/search-api";

function pickFirst(value, fallback = "") {
  if (Array.isArray(value)) {
    return value[0] || fallback;
  }

  return value || fallback;
}

function clampLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 20;
  }

  return Math.min(Math.max(parsed, 1), 100);
}

function formatDate(value) {
  if (!value) {
    return "Unknown date";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium"
  }).format(date);
}

function formatScore(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }

  return value.toFixed(3);
}

function toSafeHighlightHtml(value) {
  const raw = String(value || "No preview available.");

  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

function createSummary(result) {
  if (!result) {
    return "Connect the backend to start exploring your bookmark graph.";
  }

  if (!result.total) {
    return "No results yet. Try a broader keyword, remove a filter, or ingest more bookmarks.";
  }

  return `${result.total} result${result.total === 1 ? "" : "s"} found with ${result.strategy} retrieval.`;
}

export default async function SearchPage({ searchParams }) {
  const params = await searchParams;
  const q = pickFirst(params.q);
  const author = pickFirst(params.author);
  const domain = pickFirst(params.domain);
  const from = pickFirst(params.from);
  const to = pickFirst(params.to);
  const userId = pickFirst(params.user_id, "local-user");
  const limit = clampLimit(pickFirst(params.limit, "20"));

  let result = null;
  let errorMessage = "";

  try {
    result = await searchBookmarks({
      q,
      author,
      domain,
      from,
      to,
      user_id: userId,
      limit
    });
  } catch (error) {
    errorMessage = error.message;
  }

  const parsedQuery = result?.parsed_query;
  const items = result?.items || [];
  const activeFilters = [
    author ? { label: "Author", value: author } : null,
    domain ? { label: "Domain", value: domain } : null,
    from ? { label: "From", value: from } : null,
    to ? { label: "To", value: to } : null
  ].filter(Boolean);

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="eyebrow">v.1.0-alpha / build:2026</span>
          <h1>INDEXBOOK_[SESSION]</h1>
          <p className="hero-text">
            Searchable memory layer. Lexical + Hybrid retrieval active. 
            Terminal interface initialized for high-bandwidth exploration.
          </p>
        </div>

        <div className="hero-metrics">
          <div className="metric-card">
            <span className="metric-label">Engine_Status</span>
            <strong>{result?.strategy || "OFFLINE"}</strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Response_Time</span>
            <strong>
              {typeof result?.latency_ms === "number" ? `${result.latency_ms} ms` : "---"}
            </strong>
          </div>
          <div className="metric-card">
            <span className="metric-label">Knowledge_Graph</span>
            <strong>{result?.total ?? "???"} NODE(S)</strong>
          </div>
        </div>
      </section>

      <section className="workspace">
        <aside className="control-panel">
          <form className="search-form" action="/" method="get">
            <label className="field">
              <span>QUERY_INPUT</span>
              <input
                type="text"
                name="q"
                defaultValue={q}
                placeholder='keyword author:handle -exclude'
              />
            </label>

            <div className="field-grid">
              <label className="field">
                <span>FILTER_AUTHOR</span>
                <input type="text" name="author" defaultValue={author} placeholder="@handle" />
              </label>

              <label className="field">
                <span>FILTER_DOMAIN</span>
                <input type="text" name="domain" defaultValue={domain} placeholder="host.com" />
              </label>
            </div>

            <div className="field-grid">
              <label className="field">
                <span>DATE_START</span>
                <input type="date" name="from" defaultValue={from} />
              </label>

              <label className="field">
                <span>DATE_END</span>
                <input type="date" name="to" defaultValue={to} />
              </label>
            </div>

            <div className="form-actions">
              <button type="submit">SEARCH.EXE</button>
              <a href="/">ABORT_RESET</a>
            </div>
          </form>

          <div className="parser-panel">
            <div className="parser-header">
              <span className="eyebrow" style={{background: 'var(--accent-blue)'}}>DEBUG_OUTPUT</span>
              <p style={{marginTop: '0.5rem', fontSize: '0.75rem'}}>{createSummary(result)}</p>
            </div>

            <div className="chip-group">
              {(parsedQuery?.terms || []).map((term) => (
                <span key={`term-${term}`} className="chip">
                  T:{term}
                </span>
              ))}
              {(parsedQuery?.phrases || []).map((phrase) => (
                <span key={`phrase-${phrase}`} className="chip chip-strong">
                  P:"{phrase}"
                </span>
              ))}
              {(parsedQuery?.exclude || []).map((term) => (
                <span key={`exclude-${term}`} className="chip chip-warning">
                  X:{term}
                </span>
              ))}
            </div>

            <ul className="parser-list" style={{fontSize: '0.7rem'}}>
              <li>Postgres web-style tsquery parsing enabled.</li>
              <li>Field extraction prioritized.</li>
              <li>Hybrid relevance scoring v2 active.</li>
            </ul>
          </div>
        </aside>

        <section className="results-panel">
          {errorMessage ? (
            <div className="error-card" style={{padding: '1rem', border: '2px solid red', background: '#200'}}>
              <h2 style={{color: 'red'}}>CRITICAL_ERROR</h2>
              <p>{errorMessage}</p>
            </div>
          ) : null}

          <div className="results-header">
            <div>
              <span className="eyebrow" style={{background: 'var(--accent-yellow)', color: '#000'}}>OUTPUT_STREAM</span>
              <h2>MATCH_RESULTS</h2>
            </div>
            <div className="results-meta">
              <span>COUNT: {result?.total ?? 0}</span>
              <span>MODE: {result?.strategy || "---"}</span>
            </div>
          </div>

          <div className="result-list">
            {items.map((item) => (
              <article key={item.id} className="result-card">
                <div className="result-topline">
                  <div className="result-author">
                    <strong>{item.author_name || item.author_username || "anonymous"}</strong>
                    {item.author_username ? <span>@{item.author_username}</span> : null}
                  </div>
                  <div className="result-badges">
                    {item.source_domain ? <span className="badge">{item.source_domain}</span> : null}
                    <span className="badge">{formatDate(item.created_at)}</span>
                    {formatScore(item.score) ? (
                      <span className="badge badge-score">relevance:{formatScore(item.score)}</span>
                    ) : null}
                  </div>
                </div>

                <div className="content-wrapper">
                  {item.highlight && item.highlight.includes("<mark>") ? (
                    <div
                      className="snippet-highlight"
                      dangerouslySetInnerHTML={{
                        __html: toSafeHighlightHtml(item.highlight)
                      }}
                    />
                  ) : (
                    <p className="full-text">
                      {item.text_content || "--- NO CONTENT ---"}
                    </p>
                  )}
                </div>

                {item.media && item.media.length > 0 && (
                  <div className="media-grid">
                    {item.media.map((m, idx) => (
                      <div key={idx} className="media-item">
                        <img src={m} alt={`Media ${idx}`} loading="lazy" />
                      </div>
                    ))}
                  </div>
                )}

                {item.links && item.links.length > 0 && (
                  <div className="links-section">
                    <div className="links-title">Extracted Links:</div>
                    <div className="links-list">
                      {item.links.map((link, idx) => (
                        <a key={idx} href={link} target="_blank" rel="noreferrer" className="badge">
                          {new URL(link).hostname.replace(/^www\./, "")}
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                {item.source_url && (
                  <a href={item.source_url} target="_blank" rel="noreferrer" className="source-link">
                    EXEC : OPEN_SOURCE_URL
                  </a>
                )}

                <div className="result-footer">
                  <span>ID: {item.tweet_id || item.id.split(':').pop()}</span>
                  {item.score_breakdown ? (
                    <span className="breakdown">
                      L:{formatScore(item.score_breakdown.lexical)} / A:
                      {formatScore(item.score_breakdown.author)} / F:
                      {formatScore(item.score_breakdown.freshness)}
                    </span>
                  ) : (
                    <span>RETRIEVAL: FALLBACK</span>
                  )}
                </div>
              </article>
            ))}

            {!errorMessage && items.length === 0 ? (
              <div className="empty-state">
                <h3>No bookmarks matched this search.</h3>
                <p>Try a simpler query, remove a filter, or ingest more bookmarks from the extension.</p>
              </div>
            ) : null}
          </div>
        </section>
      </section>
    </main>
  );
}
