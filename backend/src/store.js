import { createClient } from "@supabase/supabase-js";
import { normalizeBookmark } from "./normalize.js";
import { parseSearchQuery } from "./search-query.js";
import {
  isShortenerUrl,
  resolveShortenerUrls,
  rewriteLinksWithResolved
} from "./url-resolver.js";

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
    this.isReady = false;
    this.capabilities = {
      bookmarksFirstCommentLinks: true,
      bookmarkContextLinks: true,
      goalRefreshRpc: true
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

  async upsertBatch({ userId, syncId, bookmarks, receivedAt }) {
    await this.init();

    let inserted = 0;
    let updated = 0;
    let ignoredInvalid = 0;
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

      const items = (data || []).map((row) =>
        this.mapBookmarkRow(row, {
          highlight: row.highlight || null,
          score: Number(row.score || 0),
          score_breakdown: {
            lexical: Number(row.text_rank || 0),
            author: Number(row.author_boost || 0),
            freshness: Number(row.freshness_boost || 0)
          }
        })
      );

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
    const items = (data || []).map((row) => this.mapGoalSearchRow(row));

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
        parsed_query: parsedQuery
      },
      next_steps:
        Array.isArray(plan?.next_steps) && plan.next_steps.length > 0
          ? plan.next_steps
          : [
              "Start from the highest-scoring repo or tutorial, then compare adjacent results for implementation tradeoffs."
            ],
      strategy: "goal_sql_v2",
      latency_ms: Date.now() - startedAt,
      warning: null
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

    return {
      total: count || 0,
      items: (data || []).map((row) =>
        this.mapBookmarkRow(row, {
          highlight: row.text_content || null,
          score: null,
          score_breakdown: null
        })
      ),
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
