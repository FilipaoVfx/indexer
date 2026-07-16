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
  classifyRepoReadmeSmart,
  activeClassifierVersion,
} from "./repo-classifier-llm.js";
import {
  classifyRepoReadme,
  mapRepoClassificationRow,
  REPO_CLASSIFIER_VERSION
} from "./repo-classifier.js";
import { mapReadmeStatusToRepo } from "./github-repos-metadata.js";

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

function computeRouteScore(enrichedSteps, items) {
  if (enrichedSteps.length === 0) return { score: 0, coverage: 0, total_steps: 0, matched_steps: 0 };

  const matchedCount = enrichedSteps.filter((s) => s.has_match).length;
  const coverage = matchedCount / enrichedSteps.length;

  // Average item score for matched steps (quality signal)
  const avgItemScore = items.length > 0
    ? items.reduce((sum, item) => sum + (item.score || 0), 0) / items.length
    : 0;

  // Route score: 70% coverage + 30% quality
  const score = Math.round((coverage * 0.7 + Math.min(1, avgItemScore) * 0.3) * 100);

  return {
    score,
    coverage: Math.round(coverage * 100),
    total_steps: enrichedSteps.length,
    matched_steps: matchedCount
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

function isMissingGithubRepositoriesFeatureError(error) {
  const message = extractDbErrorMessage(error).toLowerCase();
  return (
    message.includes("github_repositories") &&
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
    this.isReady = false;
    this.capabilities = {
      bookmarksFirstCommentLinks: true,
      bookmarkContextLinks: true,
      goalRefreshRpc: true,
      githubReadmes: true,
      githubRepositories: true,
      repoClassifier: true
    };
    this.repoClassifierWarning = null;
    this.githubRepositoriesWarning = null;
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

  async insertBookmarksWithFallback(bookmarksToInsert) {
    let effectiveBookmarks = this.capabilities.bookmarksFirstCommentLinks
      ? bookmarksToInsert
      : stripFirstCommentLinks(bookmarksToInsert);
    const warnings = [];

    let { data, error } = await this.supabase
      .from("bookmarks")
      .upsert(effectiveBookmarks, {
        onConflict: "id",
        ignoreDuplicates: true
      })
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

      effectiveBookmarks = stripFirstCommentLinks(bookmarksToInsert);
      ({ data, error } = await this.supabase
        .from("bookmarks")
        .upsert(effectiveBookmarks, {
          onConflict: "id",
          ignoreDuplicates: true
        })
        .select("id"));
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

  missingGithubRepositoriesWarning(error) {
    this.capabilities.githubRepositories = false;
    const warning =
      "Skipping GitHub repository metadata cache because the Supabase schema is not available. " +
      "Apply backend/sql/014_github_repositories.sql to enable the metadata-first index.";
    this.githubRepositoriesWarning = warning;
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

  // Capa 1: siembra/actualiza filas livianas en github_repositories sin llamar
  // a GitHub. Solo escribe identidad (slug/owner/repo/url); stars/topics/priority
  // se enriquecen aparte (backfill). El upsert no incluye esas columnas, así que
  // nunca pisa la metadata enriquecida ni el readme_status de filas existentes.
  async ensureRepositoryRows(repoSlugs, { receivedAt } = {}) {
    if (!this.capabilities.githubRepositories) {
      return this.githubRepositoriesWarning;
    }

    const now = receivedAt || new Date().toISOString();
    const rows = [...new Set(repoSlugs)]
      .map((repoSlug) => splitGithubRepoSlug(repoSlug))
      .filter(Boolean)
      .map((repo) => ({
        repo_slug: repo.repo_slug,
        owner: repo.owner,
        repo: repo.repo,
        url: repo.repo_url,
        updated_at: now
      }));

    if (rows.length === 0) {
      return null;
    }

    const { error } = await this.supabase
      .from("github_repositories")
      .upsert(rows, { onConflict: "repo_slug" });

    if (error) {
      if (isMissingGithubRepositoriesFeatureError(error)) {
        return this.missingGithubRepositoriesWarning(error);
      }
      throw new Error(`Failed to ensure GitHub repository rows: ${extractDbErrorMessage(error)}`);
    }

    return null;
  }

  // Usado por el backfill: escribe la fila completa con metadata + priority.
  async upsertRepositoryMetadata(rows) {
    if (!this.capabilities.githubRepositories) {
      return { upserted: 0, warning: this.githubRepositoriesWarning };
    }

    const payload = (Array.isArray(rows) ? rows : []).filter((row) => row?.repo_slug);
    if (payload.length === 0) {
      return { upserted: 0, warning: null };
    }

    const { error } = await this.supabase
      .from("github_repositories")
      .upsert(payload, { onConflict: "repo_slug" });

    if (error) {
      if (isMissingGithubRepositoriesFeatureError(error)) {
        return { upserted: 0, warning: this.missingGithubRepositoriesWarning(error) };
      }
      throw new Error(`Failed to upsert GitHub repository metadata: ${extractDbErrorMessage(error)}`);
    }

    return { upserted: payload.length, warning: null };
  }

  // Lista la metadata liviana ordenada por prioridad (lo más valioso primero).
  async listRepositories({ limit = 50, offset = 0, source = "" } = {}) {
    await this.init();
    if (!this.capabilities.githubRepositories) {
      return { total: 0, items: [], warning: this.githubRepositoriesWarning };
    }

    const normalizedLimit = clampNumber(limit, 50, 1, 100);
    const normalizedOffset = clampNumber(offset, 0, 0, 10_000);

    let queryBuilder = this.supabase
      .from("github_repositories")
      .select(
        "repo_slug,owner,repo,url,description,language,topics,stars,forks,pushed_at,source,priority,readme_status,metadata_fetched_at,updated_at",
        { count: "exact" }
      )
      .order("priority", { ascending: false })
      .order("stars", { ascending: false })
      .range(normalizedOffset, normalizedOffset + normalizedLimit - 1);

    if (source) {
      queryBuilder = queryBuilder.eq("source", source);
    }

    const { data, error, count } = await queryBuilder;
    if (error) {
      if (isMissingGithubRepositoriesFeatureError(error)) {
        return { total: 0, items: [], warning: this.missingGithubRepositoriesWarning(error) };
      }
      throw new Error(`Failed to list GitHub repositories: ${extractDbErrorMessage(error)}`);
    }

    return { total: count || 0, items: data || [], warning: null };
  }

  // Resumen de autores agregado en el servidor (reemplaza la descarga del
  // corpus completo al navegador que hacía AuthorsList). Una pasada paginada
  // sobre bookmarks + join con bookmark_github_repos para el índice de repos
  // por autor (leaderboard y modal).
  async listAuthorSummary({ user = "" } = {}) {
    await this.init();

    // 1. Pasada paginada sobre bookmarks: agrega por author_username.
    const authorsByKey = new Map();
    const authorKeyByBookmarkId = new Map();
    let totalBookmarks = 0;
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      let qb = this.supabase
        .from("bookmarks")
        .select("id,author_username,author_name,created_at,source_url")
        .range(from, from + pageSize - 1);
      if (user) qb = qb.eq("user_id", user);
      const { data, error } = await qb;
      if (error) {
        throw new Error(`Failed to aggregate authors: ${extractDbErrorMessage(error)}`);
      }
      const rows = data || [];
      totalBookmarks += rows.length;
      for (const row of rows) {
        const handle = String(row.author_username || "").trim().replace(/^@+/, "");
        const name = String(row.author_name || "").trim();
        const key = (handle || name || "?").toLowerCase();
        let entry = authorsByKey.get(key);
        if (!entry) {
          entry = {
            key,
            handle: handle || null,
            name: name || handle || "?",
            count: 0,
            latest_date: null,
            repos: new Map(),
            domains: new Set()
          };
          authorsByKey.set(key, entry);
        }
        entry.count += 1;
        if (!entry.name && name) entry.name = name;
        if (entry.domains.size < 8 && row.source_url) {
          try {
            entry.domains.add(new URL(row.source_url).hostname.replace(/^www\./, ""));
          } catch (_e) { /* url inválida: ignorar */ }
        }
        if (
          row.created_at &&
          (!entry.latest_date || new Date(row.created_at) > new Date(entry.latest_date))
        ) {
          entry.latest_date = row.created_at;
        }
        authorKeyByBookmarkId.set(String(row.id), { key, createdAt: row.created_at || null });
      }
      if (rows.length < pageSize) break;
      from += pageSize;
    }

    // 2. Índice autor → repos mencionados (vía bookmark_github_repos).
    if (this.capabilities.githubReadmes && authorKeyByBookmarkId.size > 0) {
      let linkFrom = 0;
      for (;;) {
        const { data, error } = await this.supabase
          .from("bookmark_github_repos")
          .select("bookmark_id,repo_slug")
          .range(linkFrom, linkFrom + pageSize - 1);
        if (error) {
          if (isMissingGithubReadmesFeatureError(error)) break;
          throw new Error(`Failed to read repo links for authors: ${extractDbErrorMessage(error)}`);
        }
        const rows = data || [];
        for (const link of rows) {
          const ref = authorKeyByBookmarkId.get(String(link.bookmark_id));
          if (!ref) continue;
          const entry = authorsByKey.get(ref.key);
          if (!entry) continue;
          const slug = String(link.repo_slug || "").toLowerCase();
          if (!slug) continue;
          const repo = entry.repos.get(slug) || { repo_slug: slug, count: 0, latest_date: null };
          repo.count += 1;
          if (ref.createdAt && (!repo.latest_date || new Date(ref.createdAt) > new Date(repo.latest_date))) {
            repo.latest_date = ref.createdAt;
          }
          entry.repos.set(slug, repo);
        }
        if (rows.length < pageSize) break;
        linkFrom += pageSize;
      }
    }

    const items = [...authorsByKey.values()]
      .map((entry) => ({
        handle: entry.handle,
        name: entry.name,
        count: entry.count,
        latest_date: entry.latest_date,
        domains: [...entry.domains],
        repos: [...entry.repos.values()].sort((a, b) => b.count - a.count)
      }))
      .sort((a, b) => b.count - a.count);

    return { total_authors: items.length, total_bookmarks: totalBookmarks, items };
  }

  // Contadores únicos para toda la UI (sidebar, headers). Una sola verdad.
  async getStats({ user = "" } = {}) {
    await this.init();

    let bookmarksQb = this.supabase
      .from("bookmarks")
      .select("*", { count: "exact", head: true });
    if (user) bookmarksQb = bookmarksQb.eq("user_id", user);

    const [bookmarksRes, readmesRes, reposRes] = await Promise.all([
      bookmarksQb,
      this.supabase
        .from("github_repo_readmes")
        .select("*", { count: "exact", head: true })
        .eq("status", "ok"),
      this.supabase
        .from("bookmark_github_repos")
        .select("repo_slug")
    ]);

    const repoSlugs = new Set(
      (reposRes.data || []).map((r) => String(r.repo_slug || "").toLowerCase()).filter(Boolean)
    );

    // Autores distintos: pasada paginada sobre author_username.
    const authorKeys = new Set();
    {
      const pageSize = 1000;
      let from = 0;
      for (;;) {
        let qb = this.supabase
          .from("bookmarks")
          .select("author_username,author_name")
          .range(from, from + pageSize - 1);
        if (user) qb = qb.eq("user_id", user);
        const { data } = await qb;
        const rows = data || [];
        for (const row of rows) {
          const key = String(row.author_username || row.author_name || "").trim().toLowerCase();
          if (key) authorKeys.add(key);
        }
        if (rows.length < pageSize) break;
        from += pageSize;
      }
    }

    return {
      bookmarks: bookmarksRes.count || 0,
      authors: authorKeys.size,
      repos: repoSlugs.size,
      readmes_ok: readmesRes.count || 0
    };
  }

  // Resumen de repos derivado de las tablas REALES (bookmark_github_repos +
  // github_repo_readmes + bookmarks), no de una extracción regex en el cliente.
  // Sustituye el contador "fantasma" de la vista Repos del frontend.
  async listRepoSummary({ limit = 500, offset = 0, user = "", sort = "count" } = {}) {
    await this.init();
    if (!this.capabilities.githubReadmes) {
      return {
        total: 0,
        items: [],
        bookmarks_analyzed: 0,
        warning: "bookmark_github_repos no disponible; aplica sql/007_github_repo_readmes.sql."
      };
    }

    // 1. Todos los enlaces bookmark→repo (fuente autoritativa), paginados.
    const links = [];
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      let qb = this.supabase
        .from("bookmark_github_repos")
        .select("repo_slug,bookmark_id,user_id")
        .range(from, from + pageSize - 1);
      if (user) qb = qb.eq("user_id", user);
      const { data, error } = await qb;
      if (error) {
        if (isMissingGithubReadmesFeatureError(error)) {
          return { total: 0, items: [], bookmarks_analyzed: 0, warning: this.missingGithubReadmesWarning(error) };
        }
        throw new Error(`Failed to read bookmark_github_repos: ${extractDbErrorMessage(error)}`);
      }
      const rows = data || [];
      links.push(...rows);
      if (rows.length < pageSize) break;
      from += pageSize;
    }

    // 2. Agrega por repo_slug (cuenta de bookmarks distintos).
    const bySlug = new Map();
    const allBookmarkIds = new Set();
    for (const link of links) {
      const slug = String(link.repo_slug || "").trim().toLowerCase();
      const bid = String(link.bookmark_id || "");
      if (!slug || !bid) continue;
      let entry = bySlug.get(slug);
      if (!entry) {
        entry = { repo_slug: slug, bookmarkIds: new Set() };
        bySlug.set(slug, entry);
      }
      entry.bookmarkIds.add(bid);
      allBookmarkIds.add(bid);
    }

    // 3. Metadata de bookmarks (autor de muestra + fecha más reciente).
    const bookmarkMeta = new Map();
    const idList = [...allBookmarkIds];
    for (let i = 0; i < idList.length; i += 300) {
      const chunk = idList.slice(i, i + 300);
      const { data } = await this.supabase
        .from("bookmarks")
        .select("id,author_username,author_name,created_at,source_url")
        .in("id", chunk);
      for (const row of data || []) bookmarkMeta.set(String(row.id), row);
    }

    // 4. Metadata de repos (owner/repo/url/status del README).
    const readmeMeta = new Map();
    const slugList = [...bySlug.keys()];
    for (let i = 0; i < slugList.length; i += 300) {
      const chunk = slugList.slice(i, i + 300);
      const { data } = await this.supabase
        .from("github_repo_readmes")
        .select("repo_slug,owner,repo,repo_url,status")
        .in("repo_slug", chunk);
      for (const row of data || []) readmeMeta.set(String(row.repo_slug), row);
    }

    // 5. Ensambla el resumen por repo.
    const items = [];
    for (const [slug, entry] of bySlug) {
      const meta = readmeMeta.get(slug) || splitGithubRepoSlug(slug) || {};
      let sampleAuthor = null;
      let latestDate = null;
      for (const bid of entry.bookmarkIds) {
        const bm = bookmarkMeta.get(bid);
        if (!bm) continue;
        if (!sampleAuthor && (bm.author_username || bm.author_name)) {
          sampleAuthor = bm.author_username || bm.author_name;
        }
        if (bm.created_at && (!latestDate || new Date(bm.created_at) > new Date(latestDate))) {
          latestDate = bm.created_at;
        }
      }
      const [slugOwner, slugRepo] = slug.split("/");
      items.push({
        repo_slug: slug,
        owner: meta.owner || slugOwner,
        repo: meta.repo || slugRepo,
        url: meta.repo_url || `https://github.com/${slug}`,
        count: entry.bookmarkIds.size,
        sample_author: sampleAuthor,
        latest_date: latestDate,
        readme_status: meta.status || null
      });
    }

    // 6. Orden y paginación (client-side sobre el set completo, es pequeño).
    const sorters = {
      count: (a, b) => b.count - a.count || a.repo_slug.localeCompare(b.repo_slug),
      latest: (a, b) => new Date(b.latest_date || 0) - new Date(a.latest_date || 0),
      owner: (a, b) => a.owner.localeCompare(b.owner),
      repo: (a, b) => a.repo.localeCompare(b.repo)
    };
    items.sort(sorters[sort] || sorters.count);

    const total = items.length;
    const normalizedOffset = clampNumber(offset, 0, 0, 100_000);
    const normalizedLimit = clampNumber(limit, 500, 1, 1000);
    const paged = items.slice(normalizedOffset, normalizedOffset + normalizedLimit);

    return { total, items: paged, bookmarks_analyzed: allBookmarkIds.size, warning: null };
  }

  // Bookmarks que mencionan un repo dado, desde bookmark_github_repos → bookmarks.
  // Devuelve el shape SearchItem con repo_slugs:[slug] para que las heurísticas
  // del modal (itemMentionsRepo) matcheen sin depender del corpus del navegador.
  async listRepoMentions(repoSlug, { user = "", limit = 300 } = {}) {
    await this.init();
    const slug = String(repoSlug || "").trim().toLowerCase();
    if (!slug || !this.capabilities.githubReadmes) {
      return { slug, items: [], warning: null };
    }

    let linkQb = this.supabase
      .from("bookmark_github_repos")
      .select("bookmark_id")
      .eq("repo_slug", slug)
      .limit(clampNumber(limit, 300, 1, 1000));
    if (user) linkQb = linkQb.eq("user_id", user);

    const { data: linkRows, error: linkErr } = await linkQb;
    if (linkErr) {
      if (isMissingGithubReadmesFeatureError(linkErr)) {
        return { slug, items: [], warning: this.missingGithubReadmesWarning(linkErr) };
      }
      throw new Error(`Failed to read repo mentions: ${extractDbErrorMessage(linkErr)}`);
    }

    const ids = [...new Set((linkRows || []).map((r) => String(r.bookmark_id)).filter(Boolean))];
    if (ids.length === 0) return { slug, items: [], warning: null };

    const items = [];
    for (let i = 0; i < ids.length; i += 300) {
      const chunk = ids.slice(i, i + 300);
      const { data, error } = await this.supabase
        .from("bookmarks")
        .select(
          "id,user_id,tweet_id,text_content,author_username,author_name,created_at,source_url,links,first_comment_links"
        )
        .in("id", chunk);
      if (error) {
        throw new Error(`Failed to load mention bookmarks: ${extractDbErrorMessage(error)}`);
      }
      for (const row of data || []) {
        items.push({
          id: row.id,
          user_id: row.user_id,
          tweet_id: row.tweet_id,
          text_content: row.text_content || "",
          author_username: row.author_username || "",
          author_name: row.author_name || "",
          created_at: row.created_at || null,
          source_url: row.source_url || null,
          canonical_url: null,
          links: Array.isArray(row.links) ? row.links : [],
          first_comment_links: Array.isArray(row.first_comment_links) ? row.first_comment_links : [],
          summary: null,
          repo_slugs: [slug]
        });
      }
    }

    items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    return { slug, items, warning: null };
  }

  // Lazy fetch en tiempo de lectura: cuando alguien ve los README, descarga los
  // que siguen 'pending'/'error' (acotado por githubReadmeMaxPerBatch). Reemplaza
  // el fetch eager que antes corría en la ingesta. Tolera fallos sin romper la
  // lectura. Si se pasa repoSlug, solo refresca ese repo.
  async refreshPendingReadmes({ userId = null, repoSlug = "" } = {}) {
    if (!this.capabilities.githubReadmes) {
      return { fetched: 0, warning: null };
    }

    try {
      let candidateSlugs = [];

      if (repoSlug) {
        const normalized = splitGithubRepoSlug(repoSlug)?.repo_slug;
        candidateSlugs = normalized ? [normalized] : [];
      } else {
        const cap = Math.max(1, Number(this.config.githubReadmeMaxPerBatch) || 8);
        const { data, error } = await this.supabase
          .from("github_repo_readmes")
          .select("repo_slug,status")
          .in("status", ["pending", "error"])
          .order("last_requested_at", { ascending: false })
          .limit(cap * 4);

        if (error) {
          if (isMissingGithubReadmesFeatureError(error)) {
            return { fetched: 0, warning: this.missingGithubReadmesWarning(error) };
          }
          throw error;
        }

        let pendingSlugs = (data || []).map((row) => row.repo_slug);

        if (userId && pendingSlugs.length > 0) {
          const { data: scoped, error: scopedError } = await this.supabase
            .from("bookmark_github_repos")
            .select("repo_slug")
            .eq("user_id", userId)
            .in("repo_slug", pendingSlugs);
          if (!scopedError) {
            const allowed = new Set((scoped || []).map((row) => row.repo_slug));
            pendingSlugs = pendingSlugs.filter((slug) => allowed.has(slug));
          }
        }

        candidateSlugs = pendingSlugs;
      }

      if (candidateSlugs.length === 0) {
        return { fetched: 0, warning: null };
      }

      // fetchGithubReadmesForSlugs filtra por TTL y limita a maxPerBatch.
      const result = await this.fetchGithubReadmesForSlugs(candidateSlugs);
      await this.syncRepositoryReadmeStatus(candidateSlugs);
      return { fetched: result.fetched, warning: result.warning };
    } catch (error) {
      const warning = `Lazy README refresh failed: ${extractDbErrorMessage(error)}`;
      console.warn("[store]", warning);
      return { fetched: 0, warning };
    }
  }

  // Propaga github_repo_readmes.status → github_repositories.readme_status para
  // los slugs dados, manteniendo el índice liviano consistente tras un fetch.
  async syncRepositoryReadmeStatus(repoSlugs) {
    if (!this.capabilities.githubRepositories) return;
    const slugs = [...new Set(repoSlugs)].filter(Boolean);
    if (slugs.length === 0) return;

    const { data, error } = await this.supabase
      .from("github_repo_readmes")
      .select("repo_slug,status")
      .in("repo_slug", slugs);
    if (error) {
      if (isMissingGithubReadmesFeatureError(error)) return;
      throw new Error(`Failed to read README status for sync: ${extractDbErrorMessage(error)}`);
    }

    // Agrupa por estado destino para hacer un UPDATE por grupo (máx 4) en vez
    // de uno por repo.
    const slugsByStatus = new Map();
    for (const row of data || []) {
      const readmeStatus = mapReadmeStatusToRepo(row.status);
      if (!slugsByStatus.has(readmeStatus)) slugsByStatus.set(readmeStatus, []);
      slugsByStatus.get(readmeStatus).push(row.repo_slug);
    }

    const now = new Date().toISOString();
    for (const [readmeStatus, statusSlugs] of slugsByStatus) {
      const { error: updateError } = await this.supabase
        .from("github_repositories")
        .update({ readme_status: readmeStatus, updated_at: now })
        .in("repo_slug", statusSlugs);
      if (updateError && isMissingGithubRepositoriesFeatureError(updateError)) {
        this.missingGithubRepositoriesWarning(updateError);
        return;
      }
    }
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
    if (classificationRow.classifier_version !== activeClassifierVersion()) {
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

      // LLM con concurrencia acotada (fallback interno a keyword v1).
      const CLASSIFY_CONCURRENCY = 5;
      for (let ci = 0; ci < hydratedRows.length; ci += CLASSIFY_CONCURRENCY) {
        const slice = hydratedRows.slice(ci, ci + CLASSIFY_CONCURRENCY);
        const results = await Promise.all(
          slice.map((row) => classifyRepoReadmeSmart(row, { now }))
        );
        for (const result of results) {
          classificationRows.push(result.classification);
          evidenceRows.push(...result.evidenceRows);
        }
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

      // Capa 1: deja una fila liviana de metadata por repo (enriquecida luego
      // por el backfill). No llama a GitHub.
      const repoWarning = await this.ensureRepositoryRows(syncResult.repoSlugs, { receivedAt });
      if (repoWarning) warnings.push(repoWarning);

      // Lazy por defecto: la ingesta solo marca 'pending'. El README se descarga
      // cuando el repo es relevante (al verlo) o vía backfill. Para restaurar el
      // fetch en el request path: GITHUB_README_EAGER_FETCH=true.
      if (!this.config.githubReadmeEagerFetch) {
        return { fetched: 0, skipped: syncResult.repoSlugs.length, warnings };
      }

      const fetchResult = await this.fetchGithubReadmesForSlugs(syncResult.repoSlugs);
      if (fetchResult.warning) warnings.push(fetchResult.warning);
      await this.syncRepositoryReadmeStatus(syncResult.repoSlugs);

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

  // Post-procesamiento de la ingesta (fire-and-forget). Todo lo que no afecta
  // la respuesta al cliente — expansión de shorteners, context links, repos de
  // GitHub y refresh del índice de goals — corre después de responder. Los
  // errores se registran pero nunca alcanzan el request.
  schedulePostIngestPipeline({ userId, bookmarks, receivedAt }) {
    if (!Array.isArray(bookmarks) || bookmarks.length === 0) {
      return false;
    }

    setImmediate(() => {
      this.runPostIngestPipeline({ userId, bookmarks, receivedAt }).catch((error) => {
        console.error("[store] post-ingest pipeline failed", {
          user_id: userId,
          bookmarks: bookmarks.length,
          details: extractDbErrorMessage(error) || String(error)
        });
      });
    });

    return true;
  }

  async runPostIngestPipeline({ userId, bookmarks, receivedAt }) {
    const startedAt = Date.now();
    const warnings = [];

    const expandedBookmarks = await this.expandAndPersistShortenerLinks(
      bookmarks,
      receivedAt
    );

    const contextWarning = await this.syncBookmarkContextLinks({
      bookmarks: expandedBookmarks,
      receivedAt
    });
    if (contextWarning) {
      warnings.push(contextWarning);
    }

    const githubReadmeResult = await this.processGithubReadmesForBookmarks({
      bookmarks: expandedBookmarks,
      receivedAt
    });
    warnings.push(...githubReadmeResult.warnings);

    const refreshWarning = await this.refreshGoalSearchIndex(userId);
    if (refreshWarning) {
      warnings.push(refreshWarning);
    }

    console.log("[store] post-ingest pipeline done", {
      user_id: userId,
      bookmarks: bookmarks.length,
      github_readmes_fetched: githubReadmeResult.fetched,
      github_readmes_skipped: githubReadmeResult.skipped,
      warnings: warnings.length,
      elapsed_ms: Date.now() - startedAt
    });
    if (warnings.length > 0) {
      console.warn("[store] post-ingest pipeline warnings", {
        user_id: userId,
        warnings
      });
    }
  }

  // La captura network-first de la extensión ya entrega t.co expandidos, así
  // que expandShortenerLinks es casi siempre un no-op sin red. Cuando sí hay
  // shorteners (imports históricos), la resolución corre aquí — fuera del
  // request — y los links reescritos se persisten sobre las filas ya
  // insertadas para que dedupe/repos/domains trabajen con URLs finales.
  async expandAndPersistShortenerLinks(bookmarks, receivedAt) {
    const expanded = await this.expandShortenerLinks(bookmarks);
    if (expanded === bookmarks) {
      return bookmarks;
    }

    for (let index = 0; index < expanded.length; index += 1) {
      const before = bookmarks[index];
      const after = expanded[index];
      if (!after || typeof after !== "object" || !after.id) continue;

      const patch = {};
      if (JSON.stringify(before?.links || []) !== JSON.stringify(after.links || [])) {
        patch.links = after.links || [];
      }
      if (
        this.capabilities.bookmarksFirstCommentLinks &&
        JSON.stringify(before?.first_comment_links || []) !==
          JSON.stringify(after.first_comment_links || [])
      ) {
        patch.first_comment_links = after.first_comment_links || [];
      }
      if (Object.keys(patch).length === 0) continue;
      patch.updated_at = receivedAt;

      const { error } = await this.supabase
        .from("bookmarks")
        .update(patch)
        .eq("id", after.id);
      if (error) {
        console.warn("[store] failed to persist resolved shortener links", {
          bookmark_id: after.id,
          details: extractDbErrorMessage(error)
        });
      }
    }

    return expanded;
  }

  async upsertBatch({ userId, syncId, bookmarks, receivedAt, insertOnly = false }) {
    await this.init();

    let inserted = 0;
    let updated = 0;
    let ignoredInvalid = 0;
    const warnings = [];

    const bookmarksToUpsert = [];

    for (const rawBookmark of bookmarks) {
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

    let postProcessingScheduled = false;

    if (bookmarksToUpsert.length > 0) {
      const {
        data,
        warnings: upsertWarnings
      } = insertOnly
        ? await this.insertBookmarksWithFallback(bookmarksToUpsert)
        : await this.upsertBookmarksWithFallback(bookmarksToUpsert);
      warnings.push(...upsertWarnings);

      // Supabase returns the upserted records.
      // We can distinguish between inserted and updated if we query before,
      // but for simplicity in a batch we'll count total successes.
      inserted = data.length;
      const storedBookmarkIds = new Set(
        (Array.isArray(data) ? data : [])
          .map((row) => String(row?.id || "").trim())
          .filter(Boolean)
      );
      const storedBookmarks = insertOnly
        ? bookmarksToUpsert.filter((bookmark) => storedBookmarkIds.has(String(bookmark.id || "")))
        : bookmarksToUpsert;

      postProcessingScheduled = this.schedulePostIngestPipeline({
        userId,
        bookmarks: storedBookmarks,
        receivedAt
      });
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
      // README fetch/skip ahora ocurre en el pipeline diferido; las claves se
      // conservan por compatibilidad con clientes existentes.
      github_readmes_fetched: 0,
      github_readmes_skipped: 0,
      post_processing: postProcessingScheduled ? "scheduled" : "skipped",
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

      let items = await this.attachGithubReadmes((data || []).map((row) =>
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

      if (parsedQuery.exclude.length > 0) {
        const excludeLower = parsedQuery.exclude.map((t) => t.toLowerCase());
        items = items.filter((item) => {
          const text = (item.text_content || "").toLowerCase();
          return !excludeLower.some((term) => text.includes(term));
        });
      }

      if (items.length === 0 && parsedQuery.terms.length > 1) {
        const expanded = await this.searchExpandedTerms({
          userId,
          terms: parsedQuery.terms,
          filters: parsedQuery.filters,
          exclude: parsedQuery.exclude,
          limit: normalizedLimit
        });

        if (expanded.length > 0) {
          return {
            total: expanded.length,
            items: expanded,
            parsed_query: parsedQuery,
            strategy: "fts_trgm_v2_expanded",
            latency_ms: Date.now() - startedAt,
            warning: "No exact matches found. Showing results for individual terms."
          };
        }
      }

      return {
        total: items.length,
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

  async searchExpandedTerms({ userId, terms, filters, exclude, limit }) {
    const seen = new Set();
    const merged = [];
    const perTermLimit = Math.max(Math.ceil(limit / terms.length), 5);

    for (const term of terms.slice(0, 4)) {
      try {
        const { data } = await this.supabase.rpc("search_bookmarks", {
          search_query: term,
          user_filter: userId || null,
          author_filter: filters.author || null,
          domain_filter: filters.domain || null,
          from_date: filters.from || null,
          to_date: filters.to || null,
          limit_count: perTermLimit,
          offset_count: 0
        });

        for (const row of data || []) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          merged.push(
            this.mapBookmarkRow(row, {
              highlight: row.highlight || null,
              score: Number(row.score || 0) * 0.8,
              score_breakdown: {
                lexical: Number(row.text_rank || 0),
                author: Number(row.author_boost || 0),
                freshness: Number(row.freshness_boost || 0)
              }
            })
          );
        }
      } catch {
        continue;
      }
    }

    let results = merged;

    if (exclude.length > 0) {
      const excludeLower = exclude.map((t) => t.toLowerCase());
      results = results.filter((item) => {
        const text = (item.text_content || "").toLowerCase();
        return !excludeLower.some((t) => text.includes(t));
      });
    }

    return results.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
  }

  async enrichStepsWithMetadata(steps, items) {
    if (steps.length === 0) return steps;

    const stepNames = steps.map((s) => s.step).filter(Boolean);
    let metadataMap = {};

    try {
      const { data } = await this.supabase.rpc("get_step_metadata", {
        p_steps: stepNames
      });
      if (data) {
        for (const row of data) {
          metadataMap[row.step_name] = row;
        }
      }
    } catch {
      // metadata table not applied yet — degrade gracefully
    }

    return steps.map((step) => {
      const meta = metadataMap[step.step] || {};
      const hasItemMatch = items.some((item) => {
        const tokens = new Set([
          ...(item.topics || []),
          ...(item.required_components || [])
        ].map((t) => t.toLowerCase()));
        return (step.contributing_tokens || []).some((t) =>
          tokens.has(t.toLowerCase())
        );
      });

      return {
        ...step,
        label: meta.label || step.step,
        description: meta.description || null,
        inputs: meta.inputs || [],
        outputs: meta.outputs || [],
        icon: meta.icon || "widgets",
        has_match: hasItemMatch
      };
    });
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
        .from("bookmarks")
        .select("tweet_id,updated_at,inserted_at")
        .order("inserted_at", { ascending: true })
        .range(offset, offset + limit - 1);

      if (userId) {
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
        .from("bookmarks")
        .select("tweet_id")
        .in("tweet_id", chunk);

      if (userId) {
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

      const rawSteps = Array.isArray(v3Payload.steps) ? v3Payload.steps : [];
      const enrichedSteps = await this.enrichStepsWithMetadata(rawSteps, items);
      const routeScore = computeRouteScore(enrichedSteps, items);

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
        steps: enrichedSteps,
        route_score: routeScore,
        next_steps: buildNextStepsFromPath(rawSteps),
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
