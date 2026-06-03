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
import {
  classifyRepoReadme,
  mapRepoClassificationRow,
  REPO_CLASSIFIER_VERSION
} from "./repo-classifier.js";

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, minimum), maximum);
}

function chunkArray(values = [], size = 200) {
  const out = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

const REPO_CLASSIFICATION_COLUMNS = [
  "repo_slug",
  "primary_category",
  "secondary_categories",
  "capabilities",
  "input_types",
  "output_types",
  "integration_types",
  "target_domains",
  "tech_stack",
  "deployment_modes",
  "constraints",
  "complexity",
  "maturity",
  "confidence",
  "classifier_version",
  "score_breakdown",
  "updated_at"
].join(",");

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

const DATOS_X_DASHBOARD_SAFE_SOURCE = "bookmarks_crypto_public_feed";
const DATOS_X_DASHBOARD_FALLBACK_SOURCE = "bookmarks_crypto";
const DATOS_X_DASHBOARD_COLUMNS = [
  "text_content",
  "author_username",
  "author_name",
  "created_at",
  "links",
  "first_comment_links",
  "media",
  "source_url",
  "ingested_at",
  "updated_at",
  "inserted_at"
].join(",");

const ELECTORAL_DASHBOARD_SAFE_SOURCE = "electoral_youtube_public_fact_comments";
const ELECTORAL_DASHBOARD_FALLBACK_SOURCE = "electoral_youtube_fact_comments";
const ELECTORAL_DASHBOARD_COLUMNS = [
  "source",
  "video_title",
  "source_url",
  "political_cluster",
  "candidate_reference",
  "collection_batch",
  "author_display_name",
  "published_at",
  "like_count",
  "reply_count",
  "text_clean",
  "word_count",
  "is_valid_for_analysis",
  "quality_reason",
  "political_segment",
  "sentiment",
  "sentiment_intensity",
  "primary_emotion",
  "emotion_intensity",
  "main_topic",
  "secondary_topic",
  "mobility_score",
  "transfer_signal",
  "model_name",
  "analyzed_at"
].join(",");

function normalizeDashboardText(value, maxLength = 900) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function normalizeDashboardArray(value, limit = 8) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeDashboardDate(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function buildFacet(rows, pickValue, limit = 8) {
  const counts = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const label = String(pickValue(row) || "").trim();
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({ label, count }));
}

function buildActivityFacet(rows, pickDate, limit = 14) {
  const counts = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    const timestamp = Date.parse(pickDate(row) || "");
    if (!Number.isFinite(timestamp)) continue;
    const key = new Date(timestamp).toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-limit)
    .map(([date, count]) => ({ date, count }));
}

function averageNumber(rows, pickValue) {
  let total = 0;
  let count = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const value = Number(pickValue(row));
    if (!Number.isFinite(value)) continue;
    total += value;
    count += 1;
  }

  return count > 0 ? Math.round((total / count) * 100) / 100 : 0;
}

function isMissingDashboardSourceError(error, sourceName) {
  const message = extractDbErrorMessage(error).toLowerCase();
  const source = String(sourceName || "").toLowerCase();

  return (
    source &&
    message.includes(source) &&
    (
      message.includes("schema cache") ||
      message.includes("relation") ||
      message.includes("table") ||
      message.includes("view") ||
      message.includes("does not exist") ||
      message.includes("could not find")
    )
  );
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

function isMissingRepoClassifierFeatureError(error) {
  const message = extractDbErrorMessage(error).toLowerCase();
  return (
    (
      message.includes("repo_classifications") ||
      message.includes("repo_classification_evidence")
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
    this.bookmarksTable = config.bookmarksTable || "bookmarks";
    this.bookmarkDedupeScope = config.bookmarkDedupeScope || "per_user";
    this.bookmarkConflictTarget =
      this.bookmarkDedupeScope === "global" ? "tweet_id" : "id";
    this.enableBookmarkSideEffects = config.enableBookmarkSideEffects !== false;
    this.isReady = false;
    this.capabilities = {
      bookmarksFirstCommentLinks: true,
      bookmarkContextLinks: this.enableBookmarkSideEffects,
      goalRefreshRpc: this.enableBookmarkSideEffects,
      githubReadmes: this.enableBookmarkSideEffects,
      repoClassifier: this.enableBookmarkSideEffects
    };
    this.repoClassifierWarning = null;
  }

  async init() {
    if (this.isReady) {
      return;
    }
    console.log(
      `[store] Using bookmarks table "${this.bookmarksTable}" with ${this.bookmarkDedupeScope} dedupe.`
    );
    if (!this.enableBookmarkSideEffects) {
      console.warn(
        "[store] Bookmark side effects are disabled. Context links, GitHub README pivots, and goal-search refreshes will be skipped."
      );
    }
    // No explicit initialization needed for Supabase client
    this.isReady = true;
  }

  usesGlobalBookmarkDedupe() {
    return this.bookmarkDedupeScope === "global";
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
      .from(this.bookmarksTable)
      .upsert(effectiveBookmarks, { onConflict: "id" })
      .select("id,tweet_id");

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
        .from(this.bookmarksTable)
        .upsert(effectiveBookmarks, { onConflict: "id" })
        .select("id,tweet_id"));
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

  async insertBookmarksWithFallback(bookmarksToInsert) {
    let effectiveBookmarks = this.capabilities.bookmarksFirstCommentLinks
      ? bookmarksToInsert
      : stripFirstCommentLinks(bookmarksToInsert);
    const warnings = [];

    let { data, error } = await this.supabase
      .from(this.bookmarksTable)
      .upsert(effectiveBookmarks, {
        onConflict: this.bookmarkConflictTarget,
        ignoreDuplicates: true
      })
      .select("id,tweet_id");

    if (error && this.capabilities.bookmarksFirstCommentLinks && isMissingFirstCommentLinksColumnError(error)) {
      this.capabilities.bookmarksFirstCommentLinks = false;
      const warning =
        "Stored bookmarks without the first_comment_links column because Supabase schema is outdated. " +
        "Apply backend/sql/004_search_bookmarks_scalable.sql or backend/sql/005_bookmark_context_links.sql.";
      warnings.push(warning);
      console.warn("[store]", warning, {
        details: extractDbErrorMessage(error)
      });

      effectiveBookmarks = stripFirstCommentLinks(bookmarksToInsert);
      ({ data, error } = await this.supabase
        .from(this.bookmarksTable)
        .upsert(effectiveBookmarks, {
          onConflict: this.bookmarkConflictTarget,
          ignoreDuplicates: true
        })
        .select("id,tweet_id"));
    }

    if (error) {
      throw new Error(`Failed to insert bookmarks: ${extractDbErrorMessage(error)}`);
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

  missingRepoClassifierWarning(error) {
    this.capabilities.repoClassifier = false;
    const warning =
      "Skipping repo classification because the Supabase schema is not available. " +
      "Apply backend/sql/010_repo_classifier.sql to enable cached repo classifications.";
    this.repoClassifierWarning = warning;
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

  shouldRefreshRepoClassification(readmeRow, classificationRow, force = false) {
    if (force) return true;
    if (!classificationRow) return true;
    if (classificationRow.classifier_version !== REPO_CLASSIFIER_VERSION) {
      return true;
    }

    const readmeUpdatedAt = readmeRow?.updated_at
      ? new Date(readmeRow.updated_at).getTime()
      : 0;
    const classificationUpdatedAt = classificationRow?.updated_at
      ? new Date(classificationRow.updated_at).getTime()
      : 0;

    return readmeUpdatedAt > classificationUpdatedAt;
  }

  async fetchRepoClassificationMap(repoSlugs) {
    const uniqueSlugs = [...new Set(repoSlugs)].filter(Boolean);
    if (!this.capabilities.repoClassifier || uniqueSlugs.length === 0) {
      return new Map();
    }

    const { data, error } = await this.supabase
      .from("repo_classifications")
      .select(REPO_CLASSIFICATION_COLUMNS)
      .in("repo_slug", uniqueSlugs);

    if (error) {
      if (isMissingRepoClassifierFeatureError(error)) {
        this.missingRepoClassifierWarning(error);
        return new Map();
      }
      throw new Error(`Failed to fetch repo classifications: ${extractDbErrorMessage(error)}`);
    }

    return new Map(
      (data || [])
        .map((row) => mapRepoClassificationRow(row))
        .filter(Boolean)
        .map((row) => [row.repo_slug, row])
    );
  }

  async hydrateReadmeRowsForClassification(readmeRows) {
    const rowsNeedingContent = readmeRows.filter((row) => typeof row?.content !== "string");
    if (rowsNeedingContent.length === 0) {
      return readmeRows;
    }

    const { data, error } = await this.supabase
      .from("github_repo_readmes")
      .select("repo_slug,owner,repo,repo_url,status,content,content_chars,updated_at")
      .in("repo_slug", rowsNeedingContent.map((row) => row.repo_slug));

    if (error) {
      if (isMissingGithubReadmesFeatureError(error)) {
        this.missingGithubReadmesWarning(error);
        return readmeRows;
      }
      throw new Error(`Failed to hydrate README rows for classification: ${extractDbErrorMessage(error)}`);
    }

    const hydratedBySlug = new Map((data || []).map((row) => [row.repo_slug, row]));
    return readmeRows.map((row) => hydratedBySlug.get(row.repo_slug) || row);
  }

  async ensureRepoClassificationsForReadmeRows(readmeRows, { force = false } = {}) {
    if (!this.capabilities.repoClassifier || !Array.isArray(readmeRows) || readmeRows.length === 0) {
      return {
        classifications: new Map(),
        refreshed: 0,
        warning: this.repoClassifierWarning
      };
    }

    const uniqueRows = [
      ...new Map(
        readmeRows
          .filter((row) => row?.repo_slug)
          .map((row) => [row.repo_slug, row])
      ).values()
    ];

    const existingMap = await this.fetchRepoClassificationMap(
      uniqueRows.map((row) => row.repo_slug)
    );

    if (!this.capabilities.repoClassifier) {
      return {
        classifications: existingMap,
        refreshed: 0,
        warning: this.repoClassifierWarning
      };
    }

    const candidates = uniqueRows.filter((row) =>
      this.shouldRefreshRepoClassification(row, existingMap.get(row.repo_slug), force)
    );

    if (candidates.length > 0) {
      const hydratedRows = await this.hydrateReadmeRowsForClassification(candidates);
      const now = new Date().toISOString();
      const classificationRows = [];
      const evidenceRows = [];

      for (const row of hydratedRows) {
        const result = classifyRepoReadme(row, { now });
        classificationRows.push(result.classification);
        evidenceRows.push(...result.evidenceRows);
      }

      for (const chunk of chunkArray(classificationRows, 100)) {
        const { error: upsertError } = await this.supabase
          .from("repo_classifications")
          .upsert(chunk, { onConflict: "repo_slug" });

        if (upsertError) {
          if (isMissingRepoClassifierFeatureError(upsertError)) {
            return {
              classifications: existingMap,
              refreshed: 0,
              warning: this.missingRepoClassifierWarning(upsertError)
            };
          }
          throw new Error(`Failed to upsert repo classifications: ${extractDbErrorMessage(upsertError)}`);
        }
      }

      for (const chunk of chunkArray(hydratedRows.map((row) => row.repo_slug), 100)) {
        const { error: deleteError } = await this.supabase
          .from("repo_classification_evidence")
          .delete()
          .eq("classifier_version", REPO_CLASSIFIER_VERSION)
          .in("repo_slug", chunk);

        if (deleteError) {
          if (isMissingRepoClassifierFeatureError(deleteError)) {
            return {
              classifications: existingMap,
              refreshed: classificationRows.length,
              warning: this.missingRepoClassifierWarning(deleteError)
            };
          }
          throw new Error(`Failed to clear repo classification evidence: ${extractDbErrorMessage(deleteError)}`);
        }
      }

      for (const chunk of chunkArray(evidenceRows, 500)) {
        const { error: evidenceError } = await this.supabase
          .from("repo_classification_evidence")
          .insert(chunk);

        if (evidenceError) {
          if (isMissingRepoClassifierFeatureError(evidenceError)) {
            return {
              classifications: existingMap,
              refreshed: classificationRows.length,
              warning: this.missingRepoClassifierWarning(evidenceError)
            };
          }
          throw new Error(`Failed to store repo classification evidence: ${extractDbErrorMessage(evidenceError)}`);
        }
      }
    }

    const classifications = await this.fetchRepoClassificationMap(
      uniqueRows.map((row) => row.repo_slug)
    );

    return {
      classifications,
      refreshed: candidates.length,
      warning: null
    };
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

    let warning = null;
    if (this.capabilities.repoClassifier) {
      const { data: classificationRows, error: classificationRowsError } = await this.supabase
        .from("github_repo_readmes")
        .select("repo_slug,owner,repo,repo_url,status,content,content_chars,updated_at")
        .in("repo_slug", uniqueSlugs);

      if (classificationRowsError) {
        if (isMissingGithubReadmesFeatureError(classificationRowsError)) {
          warning = this.missingGithubReadmesWarning(classificationRowsError);
        } else {
          throw new Error(
            `Failed to load README rows for classification: ${extractDbErrorMessage(classificationRowsError)}`
          );
        }
      } else {
        const classificationResult = await this.ensureRepoClassificationsForReadmeRows(
          classificationRows || []
        );
        warning = classificationResult.warning || null;
      }
    }

    return {
      fetched,
      skipped: uniqueSlugs.length - candidates.length,
      warning
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

  async upsertBatch({ userId, syncId, bookmarks, receivedAt, insertOnly = false }) {
    await this.init();

    let inserted = 0;
    let updated = 0;
    let ignoredInvalid = 0;
    let githubReadmesFetched = 0;
    let githubReadmesSkipped = 0;
    let insertedIds = [];
    const warnings = [];

    const bookmarksToUpsert = [];
    const duplicateIds = [];
    const seenBatchKeys = new Set();

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
      const batchKey = this.usesGlobalBookmarkDedupe() ? bookmark.tweet_id : bookmark.id;
      if (seenBatchKeys.has(batchKey)) {
        duplicateIds.push(bookmark.tweet_id);
        continue;
      }
      seenBatchKeys.add(batchKey);

      bookmarksToUpsert.push({
        ...bookmark,
        inserted_at: receivedAt,
        updated_at: receivedAt
      });
    }

    let bookmarksToStore = bookmarksToUpsert;
    if (this.usesGlobalBookmarkDedupe() && bookmarksToUpsert.length > 0) {
      const existingTweetIds = await this.getExistingTweetIds({
        tweetIds: bookmarksToUpsert.map((bookmark) => bookmark.tweet_id)
      });

      bookmarksToStore = bookmarksToUpsert.filter((bookmark) => {
        if (existingTweetIds.has(bookmark.tweet_id)) {
          duplicateIds.push(bookmark.tweet_id);
          return false;
        }
        return true;
      });
    }

    if (bookmarksToStore.length > 0) {
      const shouldInsertOnly = insertOnly || this.usesGlobalBookmarkDedupe();
      const {
        data,
        warnings: upsertWarnings
      } = shouldInsertOnly
        ? await this.insertBookmarksWithFallback(bookmarksToStore)
        : await this.upsertBookmarksWithFallback(bookmarksToStore);
      warnings.push(...upsertWarnings);

      // Supabase returns the upserted records. 
      // We can distinguish between inserted and updated if we query before, 
      // but for simplicity in a batch we'll count total successes.
      inserted = data.length;
      insertedIds = (Array.isArray(data) ? data : [])
        .map((row) => String(row?.tweet_id || "").trim())
        .filter(Boolean);
      const storedBookmarkIds = new Set(
        (Array.isArray(data) ? data : [])
          .map((row) => String(row?.id || "").trim())
          .filter(Boolean)
      );
      const storedTweetIds = new Set(
        (Array.isArray(data) ? data : [])
          .map((row) => String(row?.tweet_id || "").trim())
          .filter(Boolean)
      );

      if (shouldInsertOnly) {
        for (const bookmark of bookmarksToStore) {
          const wasStored = this.usesGlobalBookmarkDedupe()
            ? storedTweetIds.has(String(bookmark.tweet_id || ""))
            : storedBookmarkIds.has(String(bookmark.id || ""));
          if (!wasStored) {
            duplicateIds.push(bookmark.tweet_id);
          }
        }
      }

      const storedBookmarks = shouldInsertOnly
        ? bookmarksToStore.filter((bookmark) =>
            this.usesGlobalBookmarkDedupe()
              ? storedTweetIds.has(String(bookmark.tweet_id || ""))
              : storedBookmarkIds.has(String(bookmark.id || ""))
          )
        : bookmarksToStore;

      if (storedBookmarks.length > 0) {
        const contextWarning = await this.syncBookmarkContextLinks({
          bookmarks: storedBookmarks,
          receivedAt
        });
        if (contextWarning) {
          warnings.push(contextWarning);
        }

        const githubReadmeResult = await this.processGithubReadmesForBookmarks({
          bookmarks: storedBookmarks,
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
    }

    let totalStoredQuery = this.supabase
      .from(this.bookmarksTable)
      .select("*", { count: "exact", head: true });

    if (userId && !this.usesGlobalBookmarkDedupe()) {
      totalStoredQuery = totalStoredQuery.eq("user_id", userId);
    }

    const { count: totalStored } = await totalStoredQuery;
    const uniqueDuplicateIds = [...new Set(duplicateIds)];

    return {
      received: bookmarks.length,
      inserted,
      updated, // In Supabase upsert, we don't easily distinguish without extra checks
      ignored_invalid: ignoredInvalid,
      duplicates: uniqueDuplicateIds.length,
      duplicate_ids: uniqueDuplicateIds,
      inserted_ids: insertedIds,
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

    if (this.bookmarksTable === "bookmarks") {
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

    const fallback = await this.searchFallback({
      userId,
      parsedQuery,
      limit: normalizedLimit,
      offset: normalizedOffset
    });

    return {
      ...fallback,
      strategy: "ilike_table_fallback",
      latency_ms: Date.now() - startedAt,
      warning:
        `Ranked search RPC skipped because BOOKMARKS_TABLE=${this.bookmarksTable}; search_bookmarks reads the default bookmarks table.`
    };
  }

  async count({ userId } = {}) {
    await this.init();
    let queryBuilder = this.supabase
      .from(this.bookmarksTable)
      .select("*", { count: "exact", head: true });

    if (userId && !this.usesGlobalBookmarkDedupe()) {
      queryBuilder = queryBuilder.eq("user_id", userId);
    }

    const { count, error } = await queryBuilder;

    if (error) {
      throw new Error(`Failed to count bookmarks: ${error.message}`);
    }
    return count;
  }

  async listBookmarkIds({ userId, hardLimit = 100_000, batchSize = 1000 } = {}) {
    await this.init();

    const ids = [];
    const seen = new Set();
    let offset = 0;
    let version = "";
    const normalizedHardLimit = clampNumber(hardLimit, 100_000, 1, 500_000);
    const normalizedBatchSize = clampNumber(batchSize, 1000, 1, 5000);

    while (ids.length < normalizedHardLimit) {
      const limit = Math.min(normalizedBatchSize, normalizedHardLimit - ids.length);
      let queryBuilder = this.supabase
        .from(this.bookmarksTable)
        .select("tweet_id,updated_at,inserted_at")
        .order("inserted_at", { ascending: true })
        .range(offset, offset + limit - 1);

      if (userId && !this.usesGlobalBookmarkDedupe()) {
        queryBuilder = queryBuilder.eq("user_id", userId);
      }

      const { data, error } = await queryBuilder;

      if (error) {
        throw new Error(`Failed to list bookmark ids: ${error.message}`);
      }

      const rows = Array.isArray(data) ? data : [];

      for (const row of rows) {
        const tweetId = String(row.tweet_id || "").trim();
        if (!tweetId || seen.has(tweetId)) continue;
        seen.add(tweetId);
        ids.push(tweetId);

        const rowVersion = String(row.updated_at || row.inserted_at || "").trim();
        if (rowVersion && (!version || rowVersion > version)) {
          version = rowVersion;
        }
      }

      if (rows.length === 0 || rows.length < limit) {
        break;
      }

      offset += rows.length;
    }

    return {
      version: version || new Date(0).toISOString(),
      count: ids.length,
      ids
    };
  }

  async getExistingTweetIds({ userId, tweetIds } = {}) {
    await this.init();

    const uniqueTweetIds = [...new Set(
      (Array.isArray(tweetIds) ? tweetIds : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )];

    if (uniqueTweetIds.length === 0) {
      return new Set();
    }

    const existingIds = new Set();
    const chunkSize = 1000;

    for (let index = 0; index < uniqueTweetIds.length; index += chunkSize) {
      const chunk = uniqueTweetIds.slice(index, index + chunkSize);
      let queryBuilder = this.supabase
        .from(this.bookmarksTable)
        .select("tweet_id")
        .in("tweet_id", chunk);

      if (userId && !this.usesGlobalBookmarkDedupe()) {
        queryBuilder = queryBuilder.eq("user_id", userId);
      }

      const { data, error } = await queryBuilder;

      if (error) {
        throw new Error(`Failed to inspect existing bookmark ids: ${error.message}`);
      }

      for (const row of Array.isArray(data) ? data : []) {
        const tweetId = String(row.tweet_id || "").trim();
        if (tweetId) {
          existingIds.add(tweetId);
        }
      }
    }

    return existingIds;
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
        .from(this.bookmarksTable)
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

  async selectDashboardRows({
    safeSource,
    fallbackSource,
    columns,
    count = false,
    configure,
    errorLabel = "Failed to load dashboard rows"
  }) {
    const run = async (sourceName) => {
      const options = count ? { count: "exact" } : undefined;
      let queryBuilder = options
        ? this.supabase.from(sourceName).select(columns, options)
        : this.supabase.from(sourceName).select(columns);

      if (typeof configure === "function") {
        queryBuilder = configure(queryBuilder);
      }

      const { data, count: total, error } = await queryBuilder;
      return { data, count: total, error, sourceName };
    };

    let result = await run(safeSource);
    if (
      result.error &&
      fallbackSource &&
      isMissingDashboardSourceError(result.error, safeSource)
    ) {
      result = await run(fallbackSource);
    }

    if (result.error) {
      throw new Error(`${errorLabel}: ${extractDbErrorMessage(result.error)}`);
    }

    return {
      source: result.sourceName,
      total: typeof result.count === "number" ? result.count : null,
      rows: Array.isArray(result.data) ? result.data : []
    };
  }

  applyDatosXDashboardFilters(queryBuilder, filters = {}) {
    const searchText = escapeForOrLike(filters.q).slice(0, 160);
    const author = escapeForOrLike(filters.author).slice(0, 120);
    const domain = escapeForOrLike(filters.domain).slice(0, 120);

    if (searchText) {
      queryBuilder = queryBuilder.or(
        `text_content.ilike.%${searchText}%,author_username.ilike.%${searchText}%,author_name.ilike.%${searchText}%,source_url.ilike.%${searchText}%`
      );
    }

    if (author) {
      queryBuilder = queryBuilder.or(
        `author_username.ilike.%${author}%,author_name.ilike.%${author}%`
      );
    }

    if (domain) {
      queryBuilder = queryBuilder.ilike("source_url", `%${domain}%`);
    }

    if (filters.from) {
      queryBuilder = queryBuilder.gte("created_at", filters.from);
    }

    if (filters.to) {
      queryBuilder = queryBuilder.lte("created_at", filters.to);
    }

    return queryBuilder;
  }

  mapDatosXDashboardRow(row) {
    const links = normalizeDashboardArray(row.links, 8);
    const contextLinks = normalizeDashboardArray(row.first_comment_links, 6);
    const media = normalizeDashboardArray(row.media, 4);
    const sourceUrl = String(row.source_url || "").trim();

    return {
      text: normalizeDashboardText(row.text_content),
      author: {
        username: String(row.author_username || "").trim(),
        name: String(row.author_name || "").trim()
      },
      published_at: normalizeDashboardDate(row.created_at),
      source_url: sourceUrl,
      source_domain: extractDomainFromUrl(sourceUrl),
      links,
      context_links: contextLinks,
      media,
      link_count: links.length + contextLinks.length,
      media_count: media.length,
      ingested_at: normalizeDashboardDate(row.ingested_at),
      updated_at: normalizeDashboardDate(row.updated_at),
      inserted_at: normalizeDashboardDate(row.inserted_at)
    };
  }

  async getDatosXDashboard({
    q = "",
    author = "",
    domain = "",
    from = "",
    to = "",
    limit = 50,
    offset = 0,
    statsLimit = 2000
  } = {}) {
    await this.init();

    const normalizedLimit = clampNumber(limit, 50, 1, 100);
    const normalizedOffset = clampNumber(offset, 0, 0, 50_000);
    const normalizedStatsLimit = clampNumber(statsLimit, 2000, 100, 5000);
    const filters = { q, author, domain, from, to };

    const page = await this.selectDashboardRows({
      safeSource: DATOS_X_DASHBOARD_SAFE_SOURCE,
      fallbackSource: DATOS_X_DASHBOARD_FALLBACK_SOURCE,
      columns: DATOS_X_DASHBOARD_COLUMNS,
      count: true,
      configure: (queryBuilder) =>
        this.applyDatosXDashboardFilters(queryBuilder, filters)
          .order("created_at", { ascending: false })
          .range(normalizedOffset, normalizedOffset + normalizedLimit - 1),
      errorLabel: "Failed to load Datos X dashboard"
    });

    const stats = await this.selectDashboardRows({
      safeSource: page.source,
      fallbackSource: null,
      columns: DATOS_X_DASHBOARD_COLUMNS,
      count: false,
      configure: (queryBuilder) =>
        this.applyDatosXDashboardFilters(queryBuilder, filters)
          .order("created_at", { ascending: false })
          .range(0, normalizedStatsLimit - 1),
      errorLabel: "Failed to load Datos X facets"
    });

    const items = page.rows.map((row) => this.mapDatosXDashboardRow(row));
    const statItems = stats.rows.map((row) => this.mapDatosXDashboardRow(row));
    const safeViewActive = page.source === DATOS_X_DASHBOARD_SAFE_SOURCE;
    const uniqueAuthors = new Set(
      statItems
        .map((item) => item.author.username || item.author.name)
        .filter(Boolean)
    );
    const uniqueDomains = new Set(
      statItems.map((item) => item.source_domain).filter(Boolean)
    );

    return {
      dataset: "datos_x",
      source_contract: safeViewActive ? "safe_view" : "safe_table_projection",
      total: page.total || 0,
      limit: normalizedLimit,
      offset: normalizedOffset,
      items,
      metrics: {
        sampled_rows: statItems.length,
        unique_authors: uniqueAuthors.size,
        unique_domains: uniqueDomains.size,
        items_with_media: statItems.filter((item) => item.media_count > 0).length,
        items_with_links: statItems.filter((item) => item.link_count > 0).length
      },
      facets: {
        authors: buildFacet(
          statItems,
          (item) => item.author.username || item.author.name
        ),
        domains: buildFacet(statItems, (item) => item.source_domain),
        activity: buildActivityFacet(statItems, (item) => item.published_at)
      },
      warning: safeViewActive
        ? null
        : `Safe view ${DATOS_X_DASHBOARD_SAFE_SOURCE} is not available yet; using an explicit no-identifier column projection from Datos X.`
    };
  }

  applyElectoralDashboardFilters(queryBuilder, filters = {}) {
    const searchText = escapeForOrLike(filters.q).slice(0, 160);
    const cluster = escapeForOrLike(filters.cluster).slice(0, 120);
    const candidate = escapeForOrLike(filters.candidate).slice(0, 120);
    const segment = escapeForOrLike(filters.segment).slice(0, 120);
    const sentiment = escapeForOrLike(filters.sentiment).slice(0, 120);
    const topic = escapeForOrLike(filters.topic).slice(0, 120);
    const valid = String(filters.valid || "").trim().toLowerCase();

    if (searchText) {
      queryBuilder = queryBuilder.or(
        `text_clean.ilike.%${searchText}%,video_title.ilike.%${searchText}%,author_display_name.ilike.%${searchText}%,political_cluster.ilike.%${searchText}%,candidate_reference.ilike.%${searchText}%`
      );
    }

    if (cluster) {
      queryBuilder = queryBuilder.ilike("political_cluster", `%${cluster}%`);
    }

    if (candidate) {
      queryBuilder = queryBuilder.ilike("candidate_reference", `%${candidate}%`);
    }

    if (segment) {
      queryBuilder = queryBuilder.eq("political_segment", segment);
    }

    if (sentiment) {
      queryBuilder = queryBuilder.eq("sentiment", sentiment);
    }

    if (topic) {
      queryBuilder = queryBuilder.eq("main_topic", topic);
    }

    if (valid === "true" || valid === "false") {
      queryBuilder = queryBuilder.eq("is_valid_for_analysis", valid === "true");
    }

    if (filters.from) {
      queryBuilder = queryBuilder.gte("published_at", filters.from);
    }

    if (filters.to) {
      queryBuilder = queryBuilder.lte("published_at", filters.to);
    }

    return queryBuilder;
  }

  mapElectoralDashboardRow(row) {
    return {
      source: String(row.source || "youtube").trim(),
      video_title: normalizeDashboardText(row.video_title, 240),
      source_url: String(row.source_url || "").trim(),
      political_cluster: String(row.political_cluster || "").trim(),
      candidate_reference: String(row.candidate_reference || "").trim(),
      collection_batch: String(row.collection_batch || "").trim(),
      author_name: String(row.author_display_name || "").trim(),
      published_at: normalizeDashboardDate(row.published_at),
      engagement: {
        likes: Number(row.like_count || 0),
        replies: Number(row.reply_count || 0)
      },
      comment_text: normalizeDashboardText(row.text_clean, 900),
      processing: {
        word_count: Number(row.word_count || 0),
        valid_for_analysis: row.is_valid_for_analysis === true,
        quality_reason: String(row.quality_reason || "").trim()
      },
      analysis: {
        political_segment: String(row.political_segment || "no_clasificable").trim(),
        sentiment: String(row.sentiment || "neutral").trim(),
        sentiment_intensity: Number(row.sentiment_intensity || 0),
        primary_emotion: String(row.primary_emotion || "no_clasificable").trim(),
        emotion_intensity: Number(row.emotion_intensity || 0),
        main_topic: String(row.main_topic || "otro").trim(),
        secondary_topic: String(row.secondary_topic || "otro").trim(),
        mobility_score: Number(row.mobility_score || 0),
        transfer_signal: String(row.transfer_signal || "no_aplica").trim(),
        model_name: String(row.model_name || "").trim(),
        analyzed_at: normalizeDashboardDate(row.analyzed_at)
      }
    };
  }

  async getElectoralDashboard({
    q = "",
    cluster = "",
    candidate = "",
    segment = "",
    sentiment = "",
    topic = "",
    valid = "",
    from = "",
    to = "",
    limit = 50,
    offset = 0,
    statsLimit = 2000
  } = {}) {
    await this.init();

    const normalizedLimit = clampNumber(limit, 50, 1, 100);
    const normalizedOffset = clampNumber(offset, 0, 0, 50_000);
    const normalizedStatsLimit = clampNumber(statsLimit, 2000, 100, 5000);
    const filters = {
      q,
      cluster,
      candidate,
      segment,
      sentiment,
      topic,
      valid,
      from,
      to
    };

    const page = await this.selectDashboardRows({
      safeSource: ELECTORAL_DASHBOARD_SAFE_SOURCE,
      fallbackSource: ELECTORAL_DASHBOARD_FALLBACK_SOURCE,
      columns: ELECTORAL_DASHBOARD_COLUMNS,
      count: true,
      configure: (queryBuilder) =>
        this.applyElectoralDashboardFilters(queryBuilder, filters)
          .order("published_at", { ascending: false })
          .range(normalizedOffset, normalizedOffset + normalizedLimit - 1),
      errorLabel: "Failed to load electoral dashboard"
    });

    const stats = await this.selectDashboardRows({
      safeSource: page.source,
      fallbackSource: null,
      columns: ELECTORAL_DASHBOARD_COLUMNS,
      count: false,
      configure: (queryBuilder) =>
        this.applyElectoralDashboardFilters(queryBuilder, filters)
          .order("published_at", { ascending: false })
          .range(0, normalizedStatsLimit - 1),
      errorLabel: "Failed to load electoral facets"
    });

    const items = page.rows.map((row) => this.mapElectoralDashboardRow(row));
    const statItems = stats.rows.map((row) => this.mapElectoralDashboardRow(row));
    const safeViewActive = page.source === ELECTORAL_DASHBOARD_SAFE_SOURCE;
    const highMobility = statItems.filter(
      (item) => item.analysis.mobility_score >= 70
    ).length;

    return {
      dataset: "electoral_youtube",
      source_contract: safeViewActive ? "safe_view" : "safe_fact_projection",
      total: page.total || 0,
      limit: normalizedLimit,
      offset: normalizedOffset,
      items,
      metrics: {
        sampled_rows: statItems.length,
        valid_for_analysis: statItems.filter(
          (item) => item.processing.valid_for_analysis
        ).length,
        avg_mobility: averageNumber(
          statItems,
          (item) => item.analysis.mobility_score
        ),
        high_mobility_comments: highMobility,
        avg_sentiment_intensity: averageNumber(
          statItems,
          (item) => item.analysis.sentiment_intensity
        )
      },
      facets: {
        segments: buildFacet(
          statItems,
          (item) => item.analysis.political_segment
        ),
        sentiment: buildFacet(statItems, (item) => item.analysis.sentiment),
        emotions: buildFacet(statItems, (item) => item.analysis.primary_emotion),
        topics: buildFacet(statItems, (item) => item.analysis.main_topic),
        clusters: buildFacet(statItems, (item) => item.political_cluster),
        candidates: buildFacet(statItems, (item) => item.candidate_reference),
        activity: buildActivityFacet(statItems, (item) => item.published_at)
      },
      warning: safeViewActive
        ? null
        : `Safe view ${ELECTORAL_DASHBOARD_SAFE_SOURCE} is not available yet; using an explicit no-identifier column projection from the fact view.`
    };
  }

  async countDashboardSource(sourceName) {
    const { count, error } = await this.supabase
      .from(sourceName)
      .select("*", { count: "exact", head: true });

    if (error) {
      return {
        count: 0,
        warning: `Could not count ${sourceName}: ${extractDbErrorMessage(error)}`
      };
    }

    return { count: count || 0, warning: null };
  }

  async getDashboardOverview() {
    await this.init();

    const [
      datosXBookmarks,
      electoralRaw,
      electoralProcessed,
      electoralAnalyzed,
      electoralRuns,
      electoralErrors
    ] = await Promise.all([
      this.countDashboardSource("bookmarks_crypto"),
      this.countDashboardSource("electoral_youtube_raw_comments"),
      this.countDashboardSource("electoral_youtube_processed_comments"),
      this.countDashboardSource("electoral_youtube_analysis_results"),
      this.countDashboardSource("electoral_youtube_etl_runs"),
      this.countDashboardSource("electoral_youtube_etl_errors")
    ]);

    const warnings = [
      datosXBookmarks,
      electoralRaw,
      electoralProcessed,
      electoralAnalyzed,
      electoralRuns,
      electoralErrors
    ]
      .map((entry) => entry.warning)
      .filter(Boolean);

    return {
      generated_at: new Date().toISOString(),
      datasets: {
        datos_x: {
          total_bookmarks: datosXBookmarks.count
        },
        electoral_youtube: {
          raw_comments: electoralRaw.count,
          processed_comments: electoralProcessed.count,
          analyzed_comments: electoralAnalyzed.count,
          etl_runs: electoralRuns.count,
          etl_errors: electoralErrors.count
        }
      },
      warnings
    };
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

    if (this.bookmarksTable !== "bookmarks") {
      const fallback = await this.searchFallback({
        userId,
        parsedQuery,
        limit: normalizedLimit,
        offset: normalizedOffset
      });
      const tokens = parsedQuery.searchText
        ? parsedQuery.searchText.split(/\s+/).filter(Boolean).slice(0, 12)
        : [];
      const items = (fallback.items || []).map((item) => ({
        ...item,
        asset_type: "bookmark",
        title:
          String(item.text_content || item.source_url || item.tweet_id || item.id || "")
            .trim()
            .slice(0, 120),
        summary: item.text_content || "",
        topics: [],
        subtopics: [],
        intent_tags: [],
        required_components: [],
        difficulty: null,
        why_this_result: []
      }));

      return {
        total: fallback.total,
        items,
        grouped_results: groupGoalResults(items),
        goal_parse: {
          intent: "explore",
          topics: tokens,
          required_components: [],
          tokens,
          parsed_query: parsedQuery
        },
        steps: [],
        next_steps: [],
        strategy: "bookmark_table_ilike_fallback",
        latency_ms: Date.now() - startedAt,
        warning:
          `Goal-search RPC skipped because BOOKMARKS_TABLE=${this.bookmarksTable}; goal SQL functions read the default bookmarks table.`
      };
    }

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
        strategy: "",
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
      .from(this.bookmarksTable)
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

    const classificationResult = await this.ensureRepoClassificationsForReadmeRows(data || []);
    const classifications = classificationResult.classifications;

    return new Map(
      (data || [])
        .map((row) => {
          const readme = mapGithubReadmeRow(row, { includeContent });
          if (!readme) return null;
          return {
            ...readme,
            classification: classifications.get(readme.repo_slug) || null
          };
        })
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

    const classificationResult = await this.ensureRepoClassificationsForReadmeRows(data || []);
    const classifications = classificationResult.classifications;

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
          classification: classifications.get(row.repo_slug) || null,
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
          item.content?.toLowerCase().includes(normalizedQuery) ||
          item.classification?.primary_category?.toLowerCase().includes(normalizedQuery) ||
          item.classification?.secondary_categories?.some((value) =>
            value.toLowerCase().includes(normalizedQuery)
          ) ||
          item.classification?.capabilities?.some((value) =>
            value.toLowerCase().includes(normalizedQuery)
          ) ||
          item.classification?.integration_types?.some((value) =>
            value.toLowerCase().includes(normalizedQuery)
          ) ||
          item.classification?.tech_stack?.some((value) =>
            value.toLowerCase().includes(normalizedQuery)
          )
        );
      });

    return {
      total: mapped.length,
      items: mapped.slice(normalizedOffset, normalizedOffset + normalizedLimit),
      warning: classificationResult.warning || null
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
      .from(this.bookmarksTable)
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
      .from(this.bookmarksTable)
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
