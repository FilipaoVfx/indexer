import { createClient } from "@supabase/supabase-js";
import { normalizeBookmark } from "./normalize.js";
import { parseSearchQuery } from "./search-query.js";
import {
  isShortenerUrl,
  resolveShortenerUrls,
  rewriteLinksWithResolved
} from "./url-resolver.js";
import {
  extractGithubRepoSlugsFromBookmarkLike,
  fetchGithubReadmeRow,
  mapGithubReadmeRow,
  splitGithubRepoSlug
} from "./github-readmes.js";

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, minimum), maximum);
}

function escapeForOrLike(value) {
  return String(value || "")
    .replace(/[%*,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDomainFromUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

const GITHUB_RESERVED_SEGMENTS = new Set([
  "orgs", "sponsors", "features", "settings", "notifications", "pulls",
  "issues", "topics", "collections", "marketplace", "explore", "trending",
  "login", "signup", "about", "search", "new", "pricing", "customer-stories",
  "enterprise", "security", "site", "contact", "readme", "site-map",
  "watching", "stars", "following", "followers",
]);

function sanitizeGithubRepoSegment(value) {
  return String(value || "")
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+$/g, "");
}

function extractGithubRepoSlugFromUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  try {
    const url = new URL(value);
    if (!/(^|\.)github\.com$/i.test(url.hostname)) {
      return "";
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return "";
    }

    const owner = String(parts[0] || "").trim();
    const repo = sanitizeGithubRepoSegment(parts[1] || "");
    if (!owner || !repo || GITHUB_RESERVED_SEGMENTS.has(owner.toLowerCase())) {
      return "";
    }

    return `${owner}/${repo}`;
  } catch (_error) {
    return "";
  }
}

function countTerms(values = [], limit = 8) {
  const counts = new Map();

  for (const value of values) {
    for (const term of Array.isArray(value) ? value : []) {
      const normalized = String(term || "").trim().toLowerCase();
      if (!normalized) continue;
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term]) => term);
}

function groupGoalResults(items) {
  return {
    tools: items.filter((item) => item.asset_type === "tool").slice(0, 5),
    tutorials: items.filter((item) => item.asset_type === "tutorial").slice(0, 5),
    repos: items.filter((item) => item.asset_type === "repo").slice(0, 5),
    examples: items.filter((item) => item.asset_type === "thread").slice(0, 5)
  };
}

function extractDbErrorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error.trim();
  if (typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }
  return String(error || "").trim();
}

function isMissingFirstCommentLinksColumnError(error) {
  const message = extractDbErrorMessage(error).toLowerCase();
  return (
    message.includes("first_comment_links") &&
    (
      message.includes("schema cache") ||
      message.includes("column") ||
      message.includes("could not find") ||
      message.includes("does not exist")
    )
  );
}

function isMissingBookmarkContextLinksFeatureError(error) {
  const message = extractDbErrorMessage(error).toLowerCase();
  return (
    message.includes("bookmark_context_links") &&
    (
      message.includes("schema cache") ||
      message.includes("relation") ||
      message.includes("table") ||
      message.includes("does not exist") ||
      message.includes("could not find")
    )
  );
}

function isMissingGoalRefreshFunctionError(error) {
  const message = extractDbErrorMessage(error).toLowerCase();
  return (
    message.includes("refresh_goal_search_index") &&
    (
      message.includes("does not exist") ||
      message.includes("schema cache") ||
      message.includes("function") ||
      message.includes("could not find")
    )
  );
}

function isMissingGithubReadmesFeatureError(error) {
  const message = extractDbErrorMessage(error).toLowerCase();
  return (
    (
      message.includes("github_repo_readmes") ||
      message.includes("bookmark_github_repos")
    ) &&
    (
      message.includes("schema cache") ||
      message.includes("relation") ||
      message.includes("table") ||
      message.includes("does not exist") ||
      message.includes("could not find")
    )
  );
}

function isMissingGoalV3FeatureError(error) {
  const message = extractDbErrorMessage(error).toLowerCase();
  return (
    (message.includes("search_goal_v3") || message.includes("goal_step_dictionary")) &&
    (
      message.includes("does not exist") ||
      message.includes("schema cache") ||
      message.includes("function") ||
      message.includes("could not find") ||
      message.includes("relation")
    )
  );
}

/**
 * Turn the ordered path returned by `search_goal_v3.steps[]` into the short
 * human-readable "next steps" bullet list the SPA already renders. The
 * suggestions are template-based but derived from the composition detected
 * in the goal so they feel tailored.
 */
function buildNextStepsFromPath(steps = []) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return [
      "Start from the highest-scoring repo or tutorial, then compare adjacent results for implementation tradeoffs."
    ];
  }

  const STEP_HINTS = {
    data_extraction:
      "Lock the extraction layer first (scraper / crawler / ingestor) — everything downstream depends on its output schema.",
    data_enrichment:
      "Add an enrichment pass (cleanup, dedupe, normalization) before storing — it keeps downstream queries simple.",
    storage:
      "Pick the persistence store (Postgres, Supabase, vector DB) before building the API — migrations are the expensive step.",
    api_layer:
      "Define stable endpoint contracts before tuning ranking heuristics.",
    search_layer:
      "Validate the retrieval path first: corpus, parsing, and ranking.",
    ai_reasoning:
      "Lock the model / embedding dimensionality before storing vectors; swap later is costly.",
    workflow:
      "Wire orchestration (queues, cron, retries) once the happy path is green — avoids rework.",
    outreach:
      "Treat outreach channels (email, CRM, webhook) as the last step; test deliverability with a dry-run list first.",
    visualization:
      "Ship a minimal dashboard only after the pipeline is emitting real data — mocks hide integration gaps.",
    auth_layer:
      "Put authentication in early enough that later endpoints inherit the session / policy model.",
    deployment:
      "Automate deploy last, but design for it from day one (envs, secrets, migrations)."
  };

  const picked = steps
    .map((entry) => STEP_HINTS[entry?.step])
    .filter(Boolean);

  if (picked.length === 0) {
    return [
      "Start from the highest-scoring repo or tutorial, then compare adjacent results for implementation tradeoffs."
    ];
  }

  return picked.slice(0, 5);
}

function splitSlug(slug) {
  const value = String(slug || "").trim();
  const idx = value.indexOf("/");
  if (idx <= 0) {
    return { owner: "", repo: value };
  }
  return {
    owner: value.slice(0, idx),
    repo: value.slice(idx + 1)
  };
}

function stripFirstCommentLinks(bookmarks = []) {
  return bookmarks.map(({ first_comment_links: _ignored, ...bookmark }) => bookmark);
}

function normalizeContextLinkRows(bookmarks = [], receivedAt) {
  const rows = [];

  for (const bookmark of bookmarks) {
    const bookmarkId = String(bookmark?.id || "").trim();
    const userId = String(bookmark?.user_id || "").trim();
    const links = Array.isArray(bookmark?.first_comment_links)
      ? bookmark.first_comment_links
      : [];

    if (!bookmarkId || !userId || links.length === 0) {
      continue;
    }

    links.forEach((url, index) => {
      const normalizedUrl = String(url || "").trim();
      if (!normalizedUrl) {
        return;
      }
      rows.push({
        bookmark_id: bookmarkId,
        user_id: userId,
        link_source: "first_comment",
        position: index,
        url: normalizedUrl,
        created_at: receivedAt,
        updated_at: receivedAt
      });
    });
  }

  return rows;
}

export class BookmarkStore {
  constructor(config) {
    if (!config.supabaseUrl || !config.supabaseKey) {
      throw new Error(
        "Missing Supabase config. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SERVICE_ROLE_KEY)."
      );
    }
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    this.config = config;
    this.isReady = false;
    this.capabilities = {
      bookmarksFirstCommentLinks: true,
      bookmarkContextLinks: true,
      goalRefreshRpc: true,
      githubReadmes: true
    };
  }

  async init() {
    if (this.isReady) {
      return;
    }
    // No explicit initialization needed for Supabase client
    this.isReady = true;
  }

  async expandShortenerLinks(bookmarks) {
    if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
      return bookmarks || [];
    }

    const shortUrls = [];
    for (const bookmark of bookmarks) {
      if (!bookmark || typeof bookmark !== "object") continue;
      const pools = [
        Array.isArray(bookmark.links) ? bookmark.links : [],
        Array.isArray(bookmark.first_comment_links)
          ? bookmark.first_comment_links
          : []
      ];
      for (const pool of pools) {
        for (const url of pool) {
          if (typeof url === "string" && isShortenerUrl(url)) {
            shortUrls.push(url);
          }
        }
      }
    }

    if (shortUrls.length === 0) {
      return bookmarks;
    }

    let resolvedMap = new Map();
    try {
      resolvedMap = await resolveShortenerUrls(shortUrls);
    } catch (error) {
      console.warn(
        "[x-indexer][store] shortener resolution failed",
        error && error.message ? error.message : error
      );
      return bookmarks;
    }

    if (resolvedMap.size === 0) {
      return bookmarks;
    }

    return bookmarks.map((bookmark) => {
      if (!bookmark || typeof bookmark !== "object") return bookmark;
      const next = { ...bookmark };
      if (Array.isArray(bookmark.links)) {
        next.links = rewriteLinksWithResolved(bookmark.links, resolvedMap);
      }
      if (Array.isArray(bookmark.first_comment_links)) {
        next.first_comment_links = rewriteLinksWithResolved(
          bookmark.first_comment_links,
          resolvedMap
        );
      }
      return next;
    });
  }

  async syncBookmarkContextLinks({ bookmarks, receivedAt }) {
    if (!this.capabilities.bookmarkContextLinks) {
      return null;
    }

    const bookmarkIds = [...new Set(
      (Array.isArray(bookmarks) ? bookmarks : [])
        .map((bookmark) => String(bookmark?.id || "").trim())
        .filter(Boolean)
    )];

    if (bookmarkIds.length === 0) {
      return;
    }

    const { error: deleteError } = await this.supabase
      .from("bookmark_context_links")
      .delete()
      .eq("link_source", "first_comment")
      .in("bookmark_id", bookmarkIds);

    if (deleteError) {
      if (isMissingBookmarkContextLinksFeatureError(deleteError)) {
        this.capabilities.bookmarkContextLinks = false;
        const warning =
          "Skipping bookmark_context_links sync because the table is not available. " +
          "Apply backend/sql/005_bookmark_context_links.sql in Supabase to enable first-comment context storage.";
        console.warn("[store]", warning, {
          details: extractDbErrorMessage(deleteError)
        });
        return warning;
      }

      throw new Error(
        "Failed to clear bookmark context links. " +
          "Apply backend/sql/005_bookmark_context_links.sql first. " +
          `Details: ${deleteError.message}`
      );
    }

    const contextRows = normalizeContextLinkRows(bookmarks, receivedAt);
    if (contextRows.length === 0) {
      return;
    }

    const { error: insertError } = await this.supabase
      .from("bookmark_context_links")
      .upsert(contextRows, {
        onConflict: "bookmark_id,link_source,position"
      });

    if (insertError) {
      if (isMissingBookmarkContextLinksFeatureError(insertError)) {
        this.capabilities.bookmarkContextLinks = false;
        const warning =
          "Skipping bookmark_context_links insert because the table is not available. " +
          "Apply backend/sql/005_bookmark_context_links.sql in Supabase to enable first-comment context storage.";
        console.warn("[store]", warning, {
          details: extractDbErrorMessage(insertError)
        });
        return warning;
      }

      throw new Error(
        "Failed to store bookmark context links. " +
          "Apply backend/sql/005_bookmark_context_links.sql first. " +
          `Details: ${insertError.message}`
      );
    }
  }

  async upsertBookmarksWithFallback(bookmarksToUpsert) {
    let effectiveBookmarks = this.capabilities.bookmarksFirstCommentLinks
      ? bookmarksToUpsert
      : stripFirstCommentLinks(bookmarksToUpsert);
    const warnings = [];

    let { data, error } = await this.supabase
      .from("bookmarks")
      .upsert(effectiveBookmarks, { onConflict: "id" })
      .select("id");

    if (error && this.capabilities.bookmarksFirstCommentLinks && isMissingFirstCommentLinksColumnError(error)) {
      this.capabilities.bookmarksFirstCommentLinks = false;
      const warning =
        "Stored bookmarks without the first_comment_links column because Supabase schema is outdated. " +
        "Apply backend/sql/004_search_bookmarks_scalable.sql or backend/sql/005_bookmark_context_links.sql.";
      warnings.push(warning);
      console.warn("[store]", warning, {
        details: extractDbErrorMessage(error)
      });

      effectiveBookmarks = stripFirstCommentLinks(bookmarksToUpsert);
      ({ data, error } = await this.supabase
        .from("bookmarks")
        .upsert(effectiveBookmarks, { onConflict: "id" })
        .select("id"));
    }

    if (error) {
      throw new Error(`Failed to upsert bookmarks: ${extractDbErrorMessage(error)}`);
    }

    return {
      data: Array.isArray(data) ? data : [],
      effectiveBookmarks,
      warnings
    };
  }

  async refreshGoalSearchIndex(userId) {
    if (!this.capabilities.goalRefreshRpc) {
      return null;
    }

    const { error: refreshError } = await this.supabase.rpc(
      "refresh_goal_search_index",
      {
        target_user_id: userId
      }
    );

    if (refreshError) {
      if (isMissingGoalRefreshFunctionError(refreshError)) {
        this.capabilities.goalRefreshRpc = false;
        const warning =
          "Skipping refresh_goal_search_index because the RPC is not available. " +
          "Apply backend/sql/003_goal_search_schema.sql in Supabase to enable goal search refresh.";
        console.warn("[store]", warning, {
          details: extractDbErrorMessage(refreshError)
        });
        return warning;
      }

      throw new Error(
        "Bookmarks were stored but the goal-search index refresh failed. " +
          "Apply backend/sql/003_goal_search_schema.sql in Supabase first. " +
          `Details: ${extractDbErrorMessage(refreshError)}`
      );
    }

    return null;
  }

  missingGithubReadmesWarning(error) {
    this.capabilities.githubReadmes = false;
    const warning =
      "Skipping GitHub README extraction because the Supabase schema is not available. " +
      "Apply backend/sql/007_github_repo_readmes.sql to enable production README caching.";
    console.warn("[store]", warning, {
      details: extractDbErrorMessage(error)
    });
    return warning;
  }

  async ensureGithubReadmeRows(repoSlugs, receivedAt) {
    const rows = [...new Set(repoSlugs)]
      .map((repoSlug) => splitGithubRepoSlug(repoSlug))
      .filter(Boolean)
      .map((repo) => ({
        ...repo,
        last_requested_at: receivedAt,
        updated_at: receivedAt
      }));

    if (rows.length === 0) {
      return null;
    }

    const { error } = await this.supabase
      .from("github_repo_readmes")
      .upsert(rows, { onConflict: "repo_slug" });

    if (error) {
      if (isMissingGithubReadmesFeatureError(error)) {
        return this.missingGithubReadmesWarning(error);
      }
      throw new Error(`Failed to prepare GitHub README rows: ${extractDbErrorMessage(error)}`);
    }

    return null;
  }

  async syncBookmarkGithubRepos({ bookmarks, receivedAt }) {
    if (!this.capabilities.githubReadmes) {
      return { repoSlugs: [], warning: null };
    }

    const bookmarkIds = [...new Set(
      (Array.isArray(bookmarks) ? bookmarks : [])
        .map((bookmark) => String(bookmark?.id || "").trim())
        .filter(Boolean)
    )];

    if (bookmarkIds.length === 0) {
      return { repoSlugs: [], warning: null };
    }

    const rows = [];
    const repoSlugs = new Set();

    for (const bookmark of bookmarks) {
      const bookmarkId = String(bookmark?.id || "").trim();
      const userId = String(bookmark?.user_id || "").trim();
      if (!bookmarkId || !userId) continue;

      const bookmarkRepoSlugs = extractGithubRepoSlugsFromBookmarkLike(bookmark);
      for (const repoSlug of bookmarkRepoSlugs) {
        repoSlugs.add(repoSlug);
        rows.push({
          bookmark_id: bookmarkId,
          user_id: userId,
          repo_slug: repoSlug,
          created_at: receivedAt
        });
      }
    }

    const ensureWarning = await this.ensureGithubReadmeRows([...repoSlugs], receivedAt);
    if (ensureWarning) {
      return { repoSlugs: [], warning: ensureWarning };
    }

    const { error: deleteError } = await this.supabase
      .from("bookmark_github_repos")
      .delete()
      .in("bookmark_id", bookmarkIds);

    if (deleteError) {
      if (isMissingGithubReadmesFeatureError(deleteError)) {
        return {
          repoSlugs: [],
          warning: this.missingGithubReadmesWarning(deleteError)
        };
      }
      throw new Error(`Failed to clear bookmark GitHub repo links: ${extractDbErrorMessage(deleteError)}`);
    }

    if (rows.length > 0) {
      const { error: insertError } = await this.supabase
        .from("bookmark_github_repos")
        .upsert(rows, { onConflict: "bookmark_id,repo_slug" });

      if (insertError) {
        if (isMissingGithubReadmesFeatureError(insertError)) {
          return {
            repoSlugs: [],
            warning: this.missingGithubReadmesWarning(insertError)
          };
        }
        throw new Error(`Failed to store bookmark GitHub repo links: ${extractDbErrorMessage(insertError)}`);
      }
    }

    return { repoSlugs: [...repoSlugs], warning: null };
  }

  shouldFetchGithubReadme(row) {
    if (!row || row.status !== "ok" || !row.fetched_at) {
      return true;
    }

    const ttlMs = (Number(this.config.githubReadmeTtlHours) || 168) * 60 * 60 * 1000;
    return Date.now() - new Date(row.fetched_at).getTime() > ttlMs;
  }

  async fetchGithubReadmesForSlugs(repoSlugs) {
    if (!this.capabilities.githubReadmes || repoSlugs.length === 0) {
      return { fetched: 0, skipped: 0, warning: null };
    }

    const uniqueSlugs = [...new Set(repoSlugs)].filter(Boolean);
    const { data, error } = await this.supabase
      .from("github_repo_readmes")
      .select("repo_slug,status,fetched_at")
      .in("repo_slug", uniqueSlugs);

    if (error) {
      if (isMissingGithubReadmesFeatureError(error)) {
        return {
          fetched: 0,
          skipped: 0,
          warning: this.missingGithubReadmesWarning(error)
        };
      }
      throw new Error(`Failed to inspect GitHub README cache: ${extractDbErrorMessage(error)}`);
    }

    const existing = new Map((data || []).map((row) => [row.repo_slug, row]));
    const candidates = uniqueSlugs
      .filter((repoSlug) => this.shouldFetchGithubReadme(existing.get(repoSlug)))
      .slice(0, Number(this.config.githubReadmeMaxPerBatch) || 8);

    let fetched = 0;
    for (const repoSlug of candidates) {
      const row = await fetchGithubReadmeRow(repoSlug, {
        githubToken: this.config.githubToken,
        maxChars: this.config.githubReadmeMaxChars
      });
      const { error: upsertError } = await this.supabase
        .from("github_repo_readmes")
        .upsert(row, { onConflict: "repo_slug" });

      if (upsertError) {
        if (isMissingGithubReadmesFeatureError(upsertError)) {
          return {
            fetched,
            skipped: uniqueSlugs.length - fetched,
            warning: this.missingGithubReadmesWarning(upsertError)
          };
        }
        throw new Error(`Failed to cache GitHub README: ${extractDbErrorMessage(upsertError)}`);
      }
      fetched += 1;
    }

    return {
      fetched,
      skipped: uniqueSlugs.length - candidates.length,
      warning: null
    };
  }

  async processGithubReadmesForBookmarks({ bookmarks, receivedAt }) {
    try {
      const syncResult = await this.syncBookmarkGithubRepos({ bookmarks, receivedAt });
      const warnings = syncResult.warning ? [syncResult.warning] : [];
      if (syncResult.repoSlugs.length === 0) {
        return { fetched: 0, skipped: 0, warnings };
      }

      const fetchResult = await this.fetchGithubReadmesForSlugs(syncResult.repoSlugs);
      if (fetchResult.warning) warnings.push(fetchResult.warning);

      return {
        fetched: fetchResult.fetched,
        skipped: fetchResult.skipped,
        warnings
      };
    } catch (error) {
      const warning =
        "Bookmarks were stored, but GitHub README extraction failed: " +
        extractDbErrorMessage(error);
      console.warn("[store]", warning);
      return { fetched: 0, skipped: 0, warnings: [warning] };
    }
  }

  async upsertBatch({ userId, syncId, bookmarks, receivedAt }) {
    await this.init();

    let inserted = 0;
    let updated = 0;
    let ignoredInvalid = 0;
    let githubReadmesFetched = 0;
    let githubReadmesSkipped = 0;
    const warnings = [];

    const bookmarksToUpsert = [];

    const preparedBookmarks = await this.expandShortenerLinks(bookmarks);

    for (const rawBookmark of preparedBookmarks) {
      const normalized = normalizeBookmark(rawBookmark, {
        userId,
        syncId,
        receivedAt
      });

      if (!normalized.valid) {
        ignoredInvalid += 1;
        continue;
      }

      const bookmark = normalized.bookmark;
      bookmarksToUpsert.push({
        ...bookmark,
        inserted_at: receivedAt,
        updated_at: receivedAt
      });
    }

    if (bookmarksToUpsert.length > 0) {
      const {
        data,
        warnings: upsertWarnings
      } = await this.upsertBookmarksWithFallback(bookmarksToUpsert);
      warnings.push(...upsertWarnings);

      // Supabase returns the upserted records. 
      // We can distinguish between inserted and updated if we query before, 
      // but for simplicity in a batch we'll count total successes.
      inserted = data.length;

      const contextWarning = await this.syncBookmarkContextLinks({
        bookmarks: bookmarksToUpsert,
        receivedAt
      });
      if (contextWarning) {
        warnings.push(contextWarning);
      }

      const githubReadmeResult = await this.processGithubReadmesForBookmarks({
        bookmarks: bookmarksToUpsert,
        receivedAt
      });
      githubReadmesFetched = githubReadmeResult.fetched;
      githubReadmesSkipped = githubReadmeResult.skipped;
      warnings.push(...githubReadmeResult.warnings);

      const refreshWarning = await this.refreshGoalSearchIndex(userId);
      if (refreshWarning) {
        warnings.push(refreshWarning);
      }
    }

    const { count: totalStored } = await this.supabase
      .from("bookmarks")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    return {
      received: bookmarks.length,
      inserted,
      updated, // In Supabase upsert, we don't easily distinguish without extra checks
      ignored_invalid: ignoredInvalid,
      github_readmes_fetched: githubReadmesFetched,
      github_readmes_skipped: githubReadmesSkipped,
      total_stored: totalStored,
      warnings
    };
  }

  async search({
    userId,
    q,
    author,
    domain,
    from,
    to,
    limit = 50,
    offset = 0
  }) {
    await this.init();

    const parsedQuery = parseSearchQuery({
      q,
      author,
      domain,
      from,
      to
    });
    const normalizedLimit = clampNumber(limit, 50, 1, 100);
    const normalizedOffset = clampNumber(offset, 0, 0, 10_000);
    const startedAt = Date.now();

    try {
      const { data, error } = await this.supabase.rpc("search_bookmarks", {
        search_query: parsedQuery.searchText || null,
        user_filter: userId || null,
        author_filter: parsedQuery.filters.author || null,
        domain_filter: parsedQuery.filters.domain || null,
        from_date: parsedQuery.filters.from || null,
        to_date: parsedQuery.filters.to || null,
        limit_count: normalizedLimit,
        offset_count: normalizedOffset
      });

      if (error) {
        throw error;
      }

      const items = await this.attachGithubReadmes((data || []).map((row) =>
        this.mapBookmarkRow(row, {
          highlight: row.highlight || null,
          score: Number(row.score || 0),
          score_breakdown: {
            lexical: Number(row.text_rank || 0),
            author: Number(row.author_boost || 0),
            freshness: Number(row.freshness_boost || 0)
          }
        })
      ));

      return {
        total: Number(data?.[0]?.total_count || 0),
        items,
        parsed_query: parsedQuery,
        strategy: "fts_trgm_v2",
        latency_ms: Date.now() - startedAt,
        warning: null
      };
    } catch (_rpcError) {
      const fallback = await this.searchFallback({
        userId,
        parsedQuery,
        limit: normalizedLimit,
        offset: normalizedOffset
      });

      return {
        ...fallback,
        strategy: "ilike_fallback",
        latency_ms: Date.now() - startedAt,
        warning:
          "Ranked search function not available yet. Apply backend/sql/004_search_bookmarks_scalable.sql to enable the scalable hybrid search."
      };
    }
  }

  async count({ userId } = {}) {
    await this.init();
    let queryBuilder = this.supabase
      .from("bookmarks")
      .select("*", { count: "exact", head: true });

    if (userId) {
      queryBuilder = queryBuilder.eq("user_id", userId);
    }

    const { count, error } = await queryBuilder;
    
    if (error) {
      throw new Error(`Failed to count bookmarks: ${error.message}`);
    }
    return count;
  }

  async listUsers({ query = "", hardLimit = 10_000, batchSize = 1000 } = {}) {
    await this.init();

    const normalizedQuery = String(query || "").trim().toLowerCase();
    const counts = new Map();
    let offset = 0;
    let total = Infinity;

    while (offset < total && offset < hardLimit) {
      const limit = Math.min(batchSize, hardLimit - offset);
      const { data, count, error } = await this.supabase
        .from("bookmarks")
        .select("user_id", { count: "exact" })
        .range(offset, offset + limit - 1);

      if (error) {
        throw new Error(`Failed to list users: ${error.message}`);
      }

      total = typeof count === "number" ? count : total;
      const rows = Array.isArray(data) ? data : [];

      for (const row of rows) {
        const userId = String(row.user_id || "").trim();
        if (!userId) continue;
        if (normalizedQuery && !userId.toLowerCase().includes(normalizedQuery)) continue;
        counts.set(userId, (counts.get(userId) || 0) + 1);
      }

      if (rows.length < limit) break;
      offset += rows.length;
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([user_id, count]) => ({ user_id, count }));
  }

  mapGoalSearchRow(row) {
    const firstCommentLinks = Array.isArray(row.first_comment_links)
      ? row.first_comment_links
      : [];
    const repoSlugs = Array.isArray(row.repo_slugs) ? row.repo_slugs.filter(Boolean) : [];
    const inferredRepoSlug =
      repoSlugs[0] ||
      [
        row.canonical_url,
        row.source_url,
        ...(Array.isArray(row.links) ? row.links : []),
        ...firstCommentLinks
      ]
        .map((value) => extractGithubRepoSlugFromUrl(value))
        .find(Boolean) ||
      "";
    const effectiveRepoSlugs = inferredRepoSlug
      ? [...new Set([inferredRepoSlug, ...repoSlugs])]
      : repoSlugs;
    const effectiveAssetType =
      row.asset_type === "repo" || effectiveRepoSlugs.length > 0
        ? "repo"
        : row.asset_type;

    return {
      id: row.bookmark_id,
      asset_id: row.asset_id,
      user_id: row.user_id,
      tweet_id: row.tweet_id,
      text_content: row.text_content,
      author_username: row.author_username,
      author_name: row.author_name,
      created_at: row.created_at,
      links: row.links || [],
      first_comment_links: firstCommentLinks,
      media: row.media || [],
      source_url: row.source_url,
      source_domain: row.source_domain || extractDomainFromUrl(row.source_url),
      canonical_url: row.canonical_url || null,
      repo_slugs: effectiveRepoSlugs,
      asset_type: effectiveAssetType,
      title: row.title,
      summary: row.summary,
      topics: row.topics || [],
      subtopics: row.subtopics || [],
      intent_tags: row.intent_tags || [],
      required_components: row.required_components || [],
      difficulty: row.difficulty,
      score: Number(row.score || 0),
      why_this_result: row.why_this_result || [],
      score_breakdown: {
        text: Number(row.text_score || 0),
        topics: Number(row.topic_score || 0),
        components: Number(row.component_score || 0),
        intent: Number(row.intent_score || 0),
        graph: Number(row.relation_score || 0),
        freshness: Number(row.freshness_score || 0)
      }
    };
  }

  async goalSearch({
    goal,
    userId,
    author = "",
    domain = "",
    from = "",
    to = "",
    limit = 20,
    offset = 0
  }) {
    await this.init();

    const parsedQuery = parseSearchQuery({
      q: goal,
      author,
      domain,
      from,
      to
    });
    const normalizedLimit = clampNumber(limit, 20, 1, 100);
    const normalizedOffset = clampNumber(offset, 0, 0, 10_000);
    const startedAt = Date.now();

    // Fast path: unified v3 RPC (parse + search + readme in one round-trip).
    // Falls back to the v2 two-call path when the migration has not been
    // applied yet — so deploys stay safe while SQL catches up.
    const { data: v3Payload, error: v3Error } = await this.supabase.rpc(
      "search_goal_v3",
      {
        p_goal: goal,
        p_user_id: userId || null,
        p_author: author || null,
        p_domain: domain || null,
        p_from: parsedQuery.filters.from || null,
        p_to: parsedQuery.filters.to || null,
        p_limit: normalizedLimit,
        p_offset: normalizedOffset
      }
    );

    if (!v3Error && v3Payload) {
      const items = (v3Payload.items || []).map((row) =>
        this.mapGoalSearchRowV3(row)
      );

      return {
        total: Number(v3Payload.total || 0),
        items,
        grouped_results: groupGoalResults(items),
        goal_parse: {
          intent: v3Payload.intent || "explore",
          topics:
            items.length > 0
              ? countTerms(items.map((item) => item.topics), 8)
              : Array.isArray(v3Payload.tokens) ? v3Payload.tokens : [],
          required_components: Array.isArray(v3Payload.components)
            ? v3Payload.components
            : [],
          tokens: Array.isArray(v3Payload.tokens) ? v3Payload.tokens : [],
          tokens_expanded: Array.isArray(v3Payload.tokens_expanded)
            ? v3Payload.tokens_expanded
            : [],
          parsed_query: parsedQuery
        },
        steps: Array.isArray(v3Payload.steps) ? v3Payload.steps : [],
        next_steps: buildNextStepsFromPath(
          Array.isArray(v3Payload.steps) ? v3Payload.steps : []
        ),
        strategy: "goal_sql_v3",
        latency_ms: Date.now() - startedAt,
        warning: null
      };
    }

    if (v3Error && !isMissingGoalV3FeatureError(v3Error)) {
      throw new Error(
        "Goal search v3 query failed in Supabase. " +
          "Apply backend/sql/008_goal_search_v3.sql or inspect the function. " +
          `Details: ${v3Error.message}`
      );
    }

    // --- v2 fallback (legacy path) ----------------------------------------
    const { data: goalPlan, error: goalPlanError } = await this.supabase.rpc(
      "parse_goal_query",
      {
        p_goal: goal
      }
    );

    if (goalPlanError) {
      throw new Error(
        "Goal search schema is not installed in Supabase yet. " +
          "Apply backend/sql/003_goal_search_schema.sql first. " +
          `Details: ${goalPlanError.message}`
      );
    }

    const { data, error } = await this.supabase.rpc("search_goal_assets", {
      p_goal: goal,
      p_user_id: userId || null,
      p_author: author || null,
      p_domain: domain || null,
      p_from: parsedQuery.filters.from || null,
      p_to: parsedQuery.filters.to || null,
      p_limit: normalizedLimit,
      p_offset: normalizedOffset
    });

    if (error) {
      throw new Error(
        "Goal search query failed in Supabase. " +
          "Confirm backend/sql/003_goal_search_schema.sql is applied. " +
          `Details: ${error.message}`
      );
    }

    const plan = Array.isArray(goalPlan) ? goalPlan[0] || null : null;
    const items = await this.attachGithubReadmes(
      (data || []).map((row) => this.mapGoalSearchRow(row))
    );

    return {
      total: Number(data?.[0]?.total_count || 0),
      items,
      grouped_results: groupGoalResults(items),
      goal_parse: {
        intent: plan?.intent || "explore",
        topics:
          items.length > 0
            ? countTerms(items.map((item) => item.topics), 8)
            : plan?.goal_terms || [],
        required_components: plan?.goal_components || [],
        tokens: Array.isArray(plan?.goal_terms) ? plan.goal_terms : [],
        parsed_query: parsedQuery
      },
      steps: [],
      next_steps:
        Array.isArray(plan?.next_steps) && plan.next_steps.length > 0
          ? plan.next_steps
          : [
              "Start from the highest-scoring repo or tutorial, then compare adjacent results for implementation tradeoffs."
            ],
      strategy: "goal_sql_v2",
      latency_ms: Date.now() - startedAt,
      warning:
        "Using goal search v2 (fallback). Apply backend/sql/008_goal_search_v3.sql to enable README-aware ranking in a single DB round-trip."
    };
  }

  /**
   * Map a v3 jsonb item (from `search_goal_v3`) to the client shape used by
   * the SPA. Keeps backward compatibility with the v2 fields and synthesises
   * a minimal `github_readmes` entry from the embedded `readme` payload so
   * existing cards keep their "README available" badge without a second trip.
   */
  mapGoalSearchRowV3(row) {
    if (!row || typeof row !== "object") return null;

    const firstCommentLinks = Array.isArray(row.first_comment_links)
      ? row.first_comment_links
      : [];
    const repoSlugs = Array.isArray(row.repo_slugs)
      ? row.repo_slugs.filter(Boolean)
      : [];
    const inferredRepoSlug =
      repoSlugs[0] ||
      [
        row.canonical_url,
        row.source_url,
        ...(Array.isArray(row.links) ? row.links : []),
        ...firstCommentLinks
      ]
        .map((value) => extractGithubRepoSlugFromUrl(value))
        .find(Boolean) ||
      "";
    const effectiveRepoSlugs = inferredRepoSlug
      ? [...new Set([inferredRepoSlug, ...repoSlugs])]
      : repoSlugs;
    const effectiveAssetType =
      row.asset_type === "repo" || effectiveRepoSlugs.length > 0
        ? "repo"
        : row.asset_type;

    const readme = row.readme && typeof row.readme === "object" ? row.readme : null;
    const githubReadmes = readme && readme.slug
      ? [
          {
            repo_slug: readme.slug,
            owner: splitSlug(readme.slug).owner,
            repo: splitSlug(readme.slug).repo,
            repo_url:
              readme.url || `https://github.com/${readme.slug}`,
            status: "ok",
            content_preview: readme.preview || "",
            content_chars: Number(readme.chars || 0),
            readme_html_url: readme.url
              ? `${readme.url}/blob/HEAD/README.md`
              : null
          }
        ]
      : [];

    const breakdown = row.score_breakdown && typeof row.score_breakdown === "object"
      ? row.score_breakdown
      : {};

    return {
      id: row.bookmark_id,
      asset_id: row.asset_id,
      user_id: row.user_id,
      tweet_id: row.tweet_id,
      text_content: row.text_content,
      author_username: row.author_username,
      author_name: row.author_name,
      created_at: row.created_at,
      links: Array.isArray(row.links) ? row.links : [],
      first_comment_links: firstCommentLinks,
      media: Array.isArray(row.media) ? row.media : [],
      source_url: row.source_url,
      source_domain: row.source_domain || extractDomainFromUrl(row.source_url),
      canonical_url: row.canonical_url || null,
      repo_slugs: effectiveRepoSlugs,
      asset_type: effectiveAssetType,
      title: row.title,
      summary: row.summary,
      topics: Array.isArray(row.topics) ? row.topics : [],
      subtopics: Array.isArray(row.subtopics) ? row.subtopics : [],
      intent_tags: Array.isArray(row.intent_tags) ? row.intent_tags : [],
      required_components: Array.isArray(row.required_components)
        ? row.required_components
        : [],
      difficulty: row.difficulty,
      score: Number(row.score || 0),
      why_this_result: Array.isArray(row.why_this_result)
        ? row.why_this_result
        : [],
      score_breakdown: {
        text: Number(breakdown.fts || 0),
        readme: Number(breakdown.readme || 0),
        topics: Number(breakdown.topic || 0),
        intent: Number(breakdown.intent || 0),
        components: Number(breakdown.component || 0),
        asset_type: Number(breakdown.type || 0),
        freshness: Number(breakdown.fresh || 0)
      },
      readme_match: readme
        ? {
            slug: readme.slug,
            url: readme.url,
            preview: readme.preview,
            chars: Number(readme.chars || 0),
            score: Number(readme.score || 0)
          }
        : null,
      github_readmes: githubReadmes
    };
  }

  async searchFallback({ userId, parsedQuery, limit, offset }) {
    let queryBuilder = this.supabase
      .from("bookmarks")
      .select("*", { count: "exact" });

    if (userId) {
      queryBuilder = queryBuilder.eq("user_id", userId);
    }

    if (parsedQuery.filters.from) {
      queryBuilder = queryBuilder.gte("created_at", parsedQuery.filters.from);
    }

    if (parsedQuery.filters.to) {
      queryBuilder = queryBuilder.lte("created_at", parsedQuery.filters.to);
    }

    if (parsedQuery.filters.author) {
      const authorValue = escapeForOrLike(parsedQuery.filters.author);
      if (authorValue) {
        queryBuilder = queryBuilder.or(
          `author_username.ilike.%${authorValue}%,author_name.ilike.%${authorValue}%`
        );
      }
    }

    if (parsedQuery.filters.domain) {
      queryBuilder = queryBuilder.ilike(
        "source_url",
        `%${parsedQuery.filters.domain}%`
      );
    }

    if (parsedQuery.searchText) {
      const safeValue = escapeForOrLike(parsedQuery.searchText);
      if (safeValue) {
        queryBuilder = queryBuilder.or(
          `text_content.ilike.%${safeValue}%,author_username.ilike.%${safeValue}%,author_name.ilike.%${safeValue}%,source_url.ilike.%${safeValue}%`
        );
      }
    }

    const { data, count, error } = await queryBuilder
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to search bookmarks: ${error.message}`);
    }

    const items = await this.attachGithubReadmes((data || []).map((row) =>
      this.mapBookmarkRow(row, {
        highlight: row.text_content || null,
        score: null,
        score_breakdown: null
      })
    ));

    return {
      total: count || 0,
      items,
      parsed_query: parsedQuery
    };
  }

  mapBookmarkRow(row, overrides = {}) {
    return {
      id: row.id,
      user_id: row.user_id,
      sync_id: row.sync_id,
      tweet_id: row.tweet_id,
      text_content: row.text_content,
      author_username: row.author_username,
      author_name: row.author_name,
      created_at: row.created_at,
      links: row.links || [],
      first_comment_links: row.first_comment_links || [],
      media: row.media || [],
      source_url: row.source_url,
      ingested_at: row.ingested_at,
      updated_at: row.updated_at,
      inserted_at: row.inserted_at,
      source_domain: extractDomainFromUrl(row.source_url),
      highlight: null,
      score: null,
      score_breakdown: null,
      ...overrides
    };
  }

  async getGithubReadmesForSlugs(repoSlugs, { includeContent = false } = {}) {
    if (!this.capabilities.githubReadmes) {
      return new Map();
    }

    const uniqueSlugs = [...new Set(repoSlugs)].filter(Boolean);
    if (uniqueSlugs.length === 0) {
      return new Map();
    }

    const columns = [
      "repo_slug",
      "owner",
      "repo",
      "repo_url",
      "status",
      "readme_name",
      "readme_path",
      "readme_html_url",
      "readme_download_url",
      "content_chars",
      "content_truncated",
      "size_bytes",
      "fetched_at",
      "last_requested_at",
      "error_message",
      "error_status",
      "updated_at",
      includeContent ? "content" : null
    ].filter(Boolean).join(",");

    const { data, error } = await this.supabase
      .from("github_repo_readmes")
      .select(columns)
      .in("repo_slug", uniqueSlugs);

    if (error) {
      if (isMissingGithubReadmesFeatureError(error)) {
        this.missingGithubReadmesWarning(error);
        return new Map();
      }
      throw new Error(`Failed to fetch GitHub README cache: ${extractDbErrorMessage(error)}`);
    }

    return new Map(
      (data || [])
        .map((row) => mapGithubReadmeRow(row, { includeContent }))
        .filter(Boolean)
        .map((readme) => [readme.repo_slug, readme])
    );
  }

  async attachGithubReadmes(items, { includeContent = false } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return items || [];
    }

    const slugsById = new Map();
    const allSlugs = new Set();

    for (const item of items) {
      const repoSlugs = [
        ...new Set([
          ...(Array.isArray(item.repo_slugs) ? item.repo_slugs : []),
          ...extractGithubRepoSlugsFromBookmarkLike(item)
        ])
      ].sort();

      slugsById.set(item.id || item.asset_id || item.tweet_id, repoSlugs);
      repoSlugs.forEach((repoSlug) => allSlugs.add(repoSlug));
    }

    if (allSlugs.size === 0) {
      return items;
    }

    const readmes = await this.getGithubReadmesForSlugs([...allSlugs], {
      includeContent
    });

    return items.map((item) => {
      const key = item.id || item.asset_id || item.tweet_id;
      const repoSlugs = slugsById.get(key) || [];
      const githubReadmes = repoSlugs
        .map((repoSlug) => readmes.get(repoSlug))
        .filter(Boolean);

      return {
        ...item,
        repo_slugs: repoSlugs,
        github_readmes: githubReadmes
      };
    });
  }

  async listGithubReadmes({
    userId,
    q = "",
    repoSlug = "",
    limit = 50,
    offset = 0,
    includeContent = true
  } = {}) {
    await this.init();

    const normalizedLimit = clampNumber(limit, 50, 1, 100);
    const normalizedOffset = clampNumber(offset, 0, 0, 10_000);
    const normalizedQuery = String(q || "").trim().toLowerCase();
    const normalizedRepoSlug = repoSlug ? splitGithubRepoSlug(repoSlug)?.repo_slug || "" : "";

    let mentionRows = [];
    let scopedRepoSlugs = null;

    if (userId) {
      let mentionQuery = this.supabase
        .from("bookmark_github_repos")
        .select("repo_slug,bookmark_id,user_id")
        .eq("user_id", userId);

      if (normalizedRepoSlug) {
        mentionQuery = mentionQuery.eq("repo_slug", normalizedRepoSlug);
      }

      const { data, error } = await mentionQuery;
      if (error) {
        if (isMissingGithubReadmesFeatureError(error)) {
          return {
            total: 0,
            items: [],
            warning: this.missingGithubReadmesWarning(error)
          };
        }
        throw new Error(`Failed to list README mentions: ${extractDbErrorMessage(error)}`);
      }

      mentionRows = data || [];
      scopedRepoSlugs = [...new Set(mentionRows.map((row) => row.repo_slug))];
      if (scopedRepoSlugs.length === 0) {
        return { total: 0, items: [], warning: null };
      }
    }

    const columns = [
      "repo_slug",
      "owner",
      "repo",
      "repo_url",
      "status",
      "readme_name",
      "readme_path",
      "readme_html_url",
      "readme_download_url",
      "content_chars",
      "content_truncated",
      "size_bytes",
      "fetched_at",
      "last_requested_at",
      "error_message",
      "error_status",
      "updated_at",
      includeContent ? "content" : null
    ].filter(Boolean).join(",");

    let queryBuilder = this.supabase.from("github_repo_readmes").select(columns);

    if (scopedRepoSlugs) {
      queryBuilder = queryBuilder.in("repo_slug", scopedRepoSlugs);
    }

    if (normalizedRepoSlug) {
      queryBuilder = queryBuilder.eq("repo_slug", normalizedRepoSlug);
    }

    const { data, error } = await queryBuilder.order("updated_at", { ascending: false });
    if (error) {
      if (isMissingGithubReadmesFeatureError(error)) {
        return {
          total: 0,
          items: [],
          warning: this.missingGithubReadmesWarning(error)
        };
      }
      throw new Error(`Failed to list GitHub READMEs: ${extractDbErrorMessage(error)}`);
    }

    const repoSlugs = (data || []).map((row) => row.repo_slug);
    if (!userId && repoSlugs.length > 0) {
      const { data: allMentions, error: mentionsError } = await this.supabase
        .from("bookmark_github_repos")
        .select("repo_slug,bookmark_id,user_id")
        .in("repo_slug", repoSlugs);

      if (!mentionsError) {
        mentionRows = allMentions || [];
      }
    }

    const mentionsByRepo = new Map();
    for (const row of mentionRows) {
      const entry = mentionsByRepo.get(row.repo_slug) || {
        bookmark_ids: new Set(),
        user_ids: new Set()
      };
      entry.bookmark_ids.add(row.bookmark_id);
      entry.user_ids.add(row.user_id);
      mentionsByRepo.set(row.repo_slug, entry);
    }

    const mapped = (data || [])
      .map((row) => {
        const readme = mapGithubReadmeRow(row, { includeContent });
        const mentions = mentionsByRepo.get(row.repo_slug);
        return {
          ...readme,
          bookmark_count: mentions ? mentions.bookmark_ids.size : 0,
          bookmark_ids: mentions ? [...mentions.bookmark_ids].sort() : [],
          user_ids: mentions ? [...mentions.user_ids].sort() : []
        };
      })
      .filter((item) => {
        if (!normalizedQuery) return true;
        return (
          item.repo_slug?.toLowerCase().includes(normalizedQuery) ||
          item.repo_url?.toLowerCase().includes(normalizedQuery) ||
          item.content?.toLowerCase().includes(normalizedQuery)
        );
      });

    return {
      total: mapped.length,
      items: mapped.slice(normalizedOffset, normalizedOffset + normalizedLimit),
      warning: null
    };
  }

  async listBookmarks({
    userId,
    author = "",
    domain = "",
    from = "",
    to = "",
    limit = 100,
    offset = 0,
    ascending = false
  } = {}) {
    await this.init();

    let queryBuilder = this.supabase
      .from("bookmarks")
      .select("*", { count: "exact" });

    if (userId) {
      queryBuilder = queryBuilder.eq("user_id", userId);
    }

    if (from) {
      queryBuilder = queryBuilder.gte("created_at", from);
    }

    if (to) {
      queryBuilder = queryBuilder.lte("created_at", to);
    }

    if (author) {
      const authorValue = escapeForOrLike(author);
      if (authorValue) {
        queryBuilder = queryBuilder.or(
          `author_username.ilike.%${authorValue}%,author_name.ilike.%${authorValue}%`
        );
      }
    }

    if (domain) {
      queryBuilder = queryBuilder.ilike("source_url", `%${domain}%`);
    }

    const normalizedLimit = clampNumber(limit, 100, 1, 500);
    const normalizedOffset = clampNumber(offset, 0, 0, 10_000);
    const { data, count, error } = await queryBuilder
      .order("created_at", { ascending })
      .range(normalizedOffset, normalizedOffset + normalizedLimit - 1);

    if (error) {
      throw new Error(`Failed to list bookmarks: ${error.message}`);
    }

    return {
      total: count || 0,
      items: (data || []).map((row) => this.mapBookmarkRow(row))
    };
  }

  async getCorpus({
    userId,
    author = "",
    domain = "",
    from = "",
    to = "",
    hardLimit = 1000,
    batchSize = 200
  } = {}) {
    const all = [];
    let offset = 0;
    let total = Infinity;

    while (all.length < hardLimit && offset < total) {
      const page = await this.listBookmarks({
        userId,
        author,
        domain,
        from,
        to,
        limit: Math.min(batchSize, hardLimit - all.length),
        offset
      });

      total = page.total;
      all.push(...page.items);
      if (page.items.length === 0 || page.items.length < batchSize) {
        break;
      }

      offset += page.items.length;
    }

    return {
      total: total === Infinity ? all.length : total,
      items: all
    };
  }

  async getBookmarkById({ id, userId } = {}) {
    await this.init();
    if (!id) return null;

    let queryBuilder = this.supabase
      .from("bookmarks")
      .select("*")
      .eq("id", id)
      .limit(1);

    if (userId) {
      queryBuilder = queryBuilder.eq("user_id", userId);
    }

    const { data, error } = await queryBuilder.maybeSingle();

    if (error) {
      throw new Error(`Failed to fetch bookmark: ${error.message}`);
    }

    return data ? this.mapBookmarkRow(data) : null;
  }
}
