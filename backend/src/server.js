import http from "node:http";
import { URL } from "node:url";
import { config, validateConfig } from "./config.js";
import {
  buildClustersResponse,
  buildDiscoverResponse,
  buildGraphResponse,
  buildRelatedResponse,
  buildSemanticSearchResponse,
  buildTrendingResponse
} from "./knowledge.js";
import {
  createHttpError,
  parseJsonBody,
  sendJson,
  setCorsHeaders
} from "./http.js";
import { BookmarkStore } from "./store.js";
import { metrics, instrumentRequest, normalizeRoute } from "./metrics.js";
import { createRateLimiter, requireApiKey } from "./auth.js";

validateConfig();

if (!config.apiKey) {
  console.warn(
    "[backend] API_KEY not set — write endpoints (/api/bookmarks/batch, /bookmarks/import-batch) accept unauthenticated requests"
  );
}

const store = new BookmarkStore(config);
await store.init();

const checkWriteRateLimit = createRateLimiter({
  windowMs: config.writeRateLimitWindowMs,
  max: config.writeRateLimitMax
});

// Escritura: primero rate limit (barato, frena fuerza bruta contra la key),
// después la key.
function enforceWriteAccess(req) {
  checkWriteRateLimit(req);
  requireApiKey(req, config.apiKey);
}

function sanitizeUserId(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, 120);
}

function sanitizeTraceId(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, 160);
}

function createServerTraceId(prefix = "req") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function describeError(error) {
  return {
    code: error?.code || "internal_error",
    message: error?.message || "Unknown error",
    statusCode: typeof error?.statusCode === "number" ? error.statusCode : 500,
    stack: typeof error?.stack === "string" ? error.stack : ""
  };
}

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, minimum), maximum);
}

function decodePathParam(value) {
  try {
    return decodeURIComponent(value || "");
  } catch {
    return value || "";
  }
}

function normalizeClusterType(value) {
  return ["author", "domain", "repo"].includes(value) ? value : "domain";
}

function isBookmarkIdsRoute(routePath) {
  return routePath === "/bookmarks/ids" || routePath === "/api/bookmarks/ids";
}

function isBookmarkImportBatchRoute(routePath) {
  return (
    routePath === "/bookmarks/import-batch" ||
    routePath === "/api/bookmarks/import-batch"
  );
}

function normalizeImportSource(value) {
  const source = typeof value === "string" ? value.trim().slice(0, 120) : "";
  return source || "x_bookmarks_dom_scan";
}

function normalizeScannerImportItems(items) {
  const normalized = [];
  const invalid = [];
  const duplicateIds = [];
  const seen = new Set();

  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") {
      invalid.push({ reason: "item_not_object" });
      continue;
    }

    const tweetId = String(item.tweet_id || item.tweetId || "").trim();
    if (!/^\d+$/.test(tweetId)) {
      invalid.push({ tweet_id: tweetId || null, reason: "invalid_tweet_id" });
      continue;
    }

    if (seen.has(tweetId)) {
      duplicateIds.push(tweetId);
      continue;
    }
    seen.add(tweetId);

    const sourceUrlCandidate = typeof item.url === "string"
      ? item.url
      : typeof item.source_url === "string"
      ? item.source_url
      : "";
    const sourceUrl =
      sourceUrlCandidate.trim() || `https://x.com/i/web/status/${tweetId}`;

    normalized.push({
      tweet_id: tweetId,
      text: typeof item.text === "string" ? item.text : "",
      author_username:
        typeof item.author_handle === "string"
          ? item.author_handle.replace(/^@+/, "")
          : typeof item.author_username === "string"
          ? item.author_username.replace(/^@+/, "")
          : "",
      author_name: typeof item.author_name === "string" ? item.author_name : "",
      created_at: typeof item.created_at === "string" ? item.created_at : null,
      source_url: sourceUrl,
      links: Array.isArray(item.links) ? item.links : [],
      first_comment_links: Array.isArray(item.first_comment_links)
        ? item.first_comment_links
        : [],
      media: Array.isArray(item.media) ? item.media : []
    });
  }

  return { normalized, invalid, duplicateIds };
}

function mergeTargetIntoCorpus(target, corpusItems) {
  if (!target) return corpusItems;
  if (corpusItems.some((item) => item.id === target.id)) {
    return corpusItems;
  }

  return [target, ...corpusItems];
}

const server = http.createServer(async (req, res) => {
  if (config.metricsEnabled) {
    instrumentRequest(req, res, { skipPath: config.metricsPath });
  }

  try {
    setCorsHeaders(req, res, config.allowedOrigins);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const routePath = requestUrl.pathname;

    if (config.metricsEnabled && req.method === "GET" && routePath === config.metricsPath) {
      if (config.metricsToken) {
        const authHeader = req.headers.authorization || "";
        const provided = authHeader.startsWith("Bearer ")
          ? authHeader.slice("Bearer ".length).trim()
          : "";
        if (provided !== config.metricsToken) {
          res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Unauthorized");
          return;
        }
      }

      const body = metrics.render();
      res.writeHead(200, {
        "Content-Type": metrics.contentType,
        "Content-Length": Buffer.byteLength(body)
      });
      res.end(body);
      return;
    }

    // Lectura protegida opcional (API_KEY_PROTECT_READS=true). /health queda
    // libre para los healthchecks de Render. La escritura se valida aparte
    // en enforceWriteAccess, así que este gate solo aplica a lecturas.
    if (config.apiKeyProtectReads && routePath !== "/health") {
      requireApiKey(req, config.apiKey);
    }

    if (req.method === "GET" && routePath === "/health") {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const total = await store.count({ userId: userId || null });
      sendJson(res, 200, {
        ok: true,
        service: "x-bookmarks-backend",
        timestamp: new Date().toISOString(),
        user_id: userId || null,
        total_bookmarks: total
      });
      return;
    }

    if (req.method === "GET" && routePath === "/users") {
      const query = requestUrl.searchParams.get("q") || "";
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 50, 1, 500);
      const users = await store.listUsers({ query });

      sendJson(res, 200, {
        ok: true,
        total: users.length,
        items: users.slice(0, limit)
      });
      return;
    }

    if (req.method === "GET" && routePath === "/api/github-readmes") {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const query = requestUrl.searchParams.get("q") || "";
      const repo = requestUrl.searchParams.get("repo") || "";
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 50, 1, 100);
      const offset = clampNumber(requestUrl.searchParams.get("offset"), 0, 0, 10_000);
      const includeContent =
        requestUrl.searchParams.get("include_content") !== "false";

      // Lazy fetch: descarga al verlos los README que sigan pendientes.
      await store.refreshPendingReadmes({ userId: userId || null, repoSlug: repo });

      const result = await store.listGithubReadmes({
        userId: userId || null,
        q: query,
        repoSlug: repo,
        limit,
        offset,
        includeContent
      });

      sendJson(res, 200, {
        ok: true,
        ...result
      });
      return;
    }

    if (req.method === "GET" && /^\/api\/github-readmes\/[^/]+\/[^/]+$/.test(routePath)) {
      const [, , , owner, repo] = routePath.split("/");
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const repoSlug = `${decodePathParam(owner)}/${decodePathParam(repo)}`;

      // Lazy fetch: "ver repo" es señal de relevancia → descarga su README.
      await store.refreshPendingReadmes({ userId: userId || null, repoSlug });

      const result = await store.listGithubReadmes({
        userId: userId || null,
        repoSlug,
        limit: 1,
        offset: 0,
        includeContent: true
      });

      if (!result.items.length) {
        throw createHttpError(404, "readme_not_found", "GitHub README not found");
      }

      sendJson(res, 200, {
        ok: true,
        item: result.items[0],
        warning: result.warning
      });
      return;
    }

    if (req.method === "GET" && routePath === "/api/github/repositories") {
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 50, 1, 100);
      const offset = clampNumber(requestUrl.searchParams.get("offset"), 0, 0, 10_000);
      const source = requestUrl.searchParams.get("source") || "";

      const result = await store.listRepositories({ limit, offset, source });

      sendJson(res, 200, {
        ok: true,
        ...result
      });
      return;
    }

    // Autores agregados en servidor (mata la descarga del corpus al cliente).
    if (req.method === "GET" && routePath === "/api/authors-summary") {
      const user = sanitizeUserId(
        requestUrl.searchParams.get("user") || requestUrl.searchParams.get("user_id") || ""
      );
      const result = await store.listAuthorSummary({ user });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // Contadores únicos para toda la UI.
    if (req.method === "GET" && routePath === "/api/stats") {
      const user = sanitizeUserId(
        requestUrl.searchParams.get("user") || requestUrl.searchParams.get("user_id") || ""
      );
      const result = await store.getStats({ user });
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // Resumen de repos desde tablas reales (bookmark_github_repos + readmes).
    if (req.method === "GET" && routePath === "/api/github/repos-summary") {
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 500, 1, 1000);
      const offset = clampNumber(requestUrl.searchParams.get("offset"), 0, 0, 10_000);
      const user = sanitizeUserId(
        requestUrl.searchParams.get("user") || requestUrl.searchParams.get("user_id") || ""
      );
      const sort = requestUrl.searchParams.get("sort") || "count";

      const result = await store.listRepoSummary({ limit, offset, user, sort });

      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    // Bookmarks que mencionan un repo (para el modal de menciones).
    if (req.method === "GET" && routePath === "/api/github/repo-mentions") {
      const slug = (requestUrl.searchParams.get("slug") || "").trim();
      if (!slug) {
        throw createHttpError(400, "slug_required", "Query param slug is required");
      }
      const user = sanitizeUserId(
        requestUrl.searchParams.get("user") || requestUrl.searchParams.get("user_id") || ""
      );

      const result = await store.listRepoMentions(slug, { user });

      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === "GET" && isBookmarkIdsRoute(routePath)) {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const hardLimit = clampNumber(
        requestUrl.searchParams.get("limit"),
        100_000,
        1,
        500_000
      );
      const result = await store.listBookmarkIds({
        userId: userId || null,
        hardLimit
      });

      sendJson(res, 200, {
        ok: true,
        user_id: userId || null,
        ...result
      });
      return;
    }

    if (req.method === "POST" && isBookmarkImportBatchRoute(routePath)) {
      enforceWriteAccess(req);
      const body = await parseJsonBody(req);
      const traceId = sanitizeTraceId(body.traceId) || createServerTraceId("import");
      req.traceId = traceId;

      if (!Array.isArray(body.items)) {
        throw createHttpError(
          400,
          "items_must_be_array",
          "Field items must be an array"
        );
      }

      if (body.items.length > config.maxBatchSize) {
        throw createHttpError(
          413,
          "batch_too_large",
          `Batch size exceeds max of ${config.maxBatchSize}`
        );
      }

      const userId = sanitizeUserId(body.user_id) || "local-user";
      const source = normalizeImportSource(body.source);
      const receivedAt = new Date().toISOString();
      const { normalized, invalid, duplicateIds } = normalizeScannerImportItems(body.items);
      const existingIds = await store.getExistingTweetIds({
        userId,
        tweetIds: normalized.map((item) => item.tweet_id)
      });
      const duplicates = [...duplicateIds];
      const newItems = [];

      for (const item of normalized) {
        if (existingIds.has(item.tweet_id)) {
          duplicates.push(item.tweet_id);
        } else {
          newItems.push(item);
        }
      }

      const summary = newItems.length > 0
        ? await store.upsertBatch({
            userId,
            syncId: source,
            bookmarks: newItems,
            receivedAt,
            insertOnly: true
          })
        : {
            received: 0,
            inserted: 0,
            updated: 0,
            ignored_invalid: 0,
            warnings: []
          };

      metrics.bookmarksIngestedTotal.inc({ source }, summary.inserted || 0);
      metrics.ingestBatchesTotal.inc({ endpoint: "import_batch", status: "ok" });

      sendJson(res, 200, {
        ok: true,
        trace_id: traceId,
        user_id: userId,
        source,
        received: body.items.length,
        inserted: summary.inserted || 0,
        duplicates: [...new Set(duplicates)].length,
        failed: invalid.length + (summary.ignored_invalid || 0),
        duplicate_ids: [...new Set(duplicates)],
        imported_ids: newItems.map((item) => item.tweet_id),
        invalid,
        total_stored: summary.total_stored ?? null,
        warnings: summary.warnings || []
      });
      return;
    }

    if (req.method === "POST" && routePath === "/api/bookmarks/batch") {
      enforceWriteAccess(req);
      const body = await parseJsonBody(req);
      const traceId = sanitizeTraceId(body.traceId) || createServerTraceId("batch");
      req.traceId = traceId;

      if (!Array.isArray(body.bookmarks)) {
        throw createHttpError(
          400,
          "bookmarks_must_be_array",
          "Field bookmarks must be an array"
        );
      }

      if (body.bookmarks.length > config.maxBatchSize) {
        throw createHttpError(
          413,
          "batch_too_large",
          `Batch size exceeds max of ${config.maxBatchSize}`
        );
      }

      const userId = sanitizeUserId(body.user_id) || "local-user";
      const syncId =
        typeof body.sync_id === "string" ? body.sync_id.trim().slice(0, 120) : null;
      const receivedAt = new Date().toISOString();

      const summary = await store.upsertBatch({
        userId,
        syncId,
        bookmarks: body.bookmarks,
        receivedAt
      });

      metrics.bookmarksIngestedTotal.inc(
        { source: syncId || "api_batch" },
        summary.inserted || 0
      );
      metrics.ingestBatchesTotal.inc({ endpoint: "batch", status: "ok" });

      sendJson(res, 200, {
        ok: true,
        trace_id: traceId,
        user_id: userId,
        sync_id: syncId,
        ...summary
      });
      return;
    }

    // Candidatos para el re-lookup diferido: posts "densos" (cue tipo
    // "REPOOO👇") guardados sin link de GitHub porque el reply no existía al
    // capturar o el tab de detalle falló. La extensión los consume, re-corre
    // el lookup del primer comentario y parchea vía PATCH.
    if (req.method === "GET" && routePath === "/api/bookmarks/relookup-candidates") {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 50, 1, 200);
      const scanLimit = clampNumber(
        requestUrl.searchParams.get("scan_limit"),
        4000,
        100,
        20_000
      );

      const result = await store.listFirstCommentRelookupCandidates({
        userId: userId || null,
        limit,
        scanLimit
      });

      sendJson(res, 200, {
        ok: true,
        user_id: userId || null,
        ...result
      });
      return;
    }

    if (req.method === "PATCH" && routePath === "/api/bookmarks/first-comment-links") {
      enforceWriteAccess(req);

      const body = await parseJsonBody(req);
      const traceId = sanitizeTraceId(body.traceId) || createServerTraceId("fclpatch");
      req.traceId = traceId;

      const userId = sanitizeUserId(body.user_id) || "local-user";
      const tweetId = String(body.tweet_id || "").trim();
      if (!/^\d+$/.test(tweetId)) {
        throw createHttpError(
          400,
          "invalid_tweet_id",
          "Field tweet_id must be a numeric tweet id"
        );
      }

      const links = (Array.isArray(body.first_comment_links) ? body.first_comment_links : [])
        .filter((value) => typeof value === "string" && /^https?:\/\//i.test(value.trim()));

      if (links.length === 0) {
        throw createHttpError(
          400,
          "first_comment_links_required",
          "Field first_comment_links must contain at least one http(s) URL"
        );
      }

      const result = await store.updateBookmarkFirstCommentLinks({ userId, tweetId, links });
      if (!result) {
        throw createHttpError(404, "bookmark_not_found", "Bookmark not found");
      }

      sendJson(res, 200, {
        ok: true,
        trace_id: traceId,
        ...result
      });
      return;
    }

    if (req.method === "GET" && routePath === "/api/bookmarks/search") {
      const query = requestUrl.searchParams.get("q") || "";
      const author = requestUrl.searchParams.get("author") || "";
      const domain = requestUrl.searchParams.get("domain") || "";
      const from = requestUrl.searchParams.get("from") || "";
      const to = requestUrl.searchParams.get("to") || "";
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const limit = Number(requestUrl.searchParams.get("limit") || 50);
      const offset = Number(requestUrl.searchParams.get("offset") || 0);

      const result = await store.search({
        userId: userId || null,
        q: query,
        author,
        domain,
        from,
        to,
        limit,
        offset
      });

      metrics.searchRequestsTotal.inc({
        type: "search",
        strategy: result.strategy || "unknown"
      });
      metrics.searchDuration.observe(
        { type: "search", strategy: result.strategy || "unknown" },
        (result.latency_ms || 0) / 1000
      );

      sendJson(res, 200, {
        ok: true,
        total: result.total,
        items: result.items,
        strategy: result.strategy,
        latency_ms: result.latency_ms,
        parsed_query: result.parsed_query,
        warning: result.warning
      });
      return;
    }

    if (req.method === "GET" && routePath === "/search") {
      const query = requestUrl.searchParams.get("q") || "";
      const author = requestUrl.searchParams.get("author") || "";
      const domain = requestUrl.searchParams.get("domain") || "";
      const from = requestUrl.searchParams.get("from") || "";
      const to = requestUrl.searchParams.get("to") || "";
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const limit = Number(requestUrl.searchParams.get("limit") || 50);
      const offset = Number(requestUrl.searchParams.get("offset") || 0);

      const result = await store.search({
        userId: userId || null,
        q: query,
        author,
        domain,
        from,
        to,
        limit,
        offset
      });

      metrics.searchRequestsTotal.inc({
        type: "search",
        strategy: result.strategy || "unknown"
      });
      metrics.searchDuration.observe(
        { type: "search", strategy: result.strategy || "unknown" },
        (result.latency_ms || 0) / 1000
      );

      sendJson(res, 200, {
        ok: true,
        query,
        total: result.total,
        items: result.items,
        strategy: result.strategy,
        latency_ms: result.latency_ms,
        parsed_query: result.parsed_query,
        warning: result.warning
      });
      return;
    }

    if (req.method === "GET" && routePath === "/search/semantic") {
      const query = requestUrl.searchParams.get("q") || "";
      if (!query.trim()) {
        throw createHttpError(400, "missing_query", "Query parameter q is required");
      }

      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const author = requestUrl.searchParams.get("author") || "";
      const domain = requestUrl.searchParams.get("domain") || "";
      const from = requestUrl.searchParams.get("from") || "";
      const to = requestUrl.searchParams.get("to") || "";
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 20, 1, 100);
      const corpusLimit = clampNumber(requestUrl.searchParams.get("corpus_limit"), 800, 50, 2000);

      const corpus = await store.getCorpus({
        userId: userId || null,
        author,
        domain,
        from,
        to,
        hardLimit: corpusLimit
      });

      metrics.searchRequestsTotal.inc({ type: "semantic", strategy: "semantic" });

      sendJson(
        res,
        200,
        buildSemanticSearchResponse({
          query,
          items: corpus.items,
          limit,
          filters: { author, domain, from, to }
        })
      );
      return;
    }

    if (req.method === "POST" && routePath === "/search/goal") {
      const body = await parseJsonBody(req);
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";

      if (!goal) {
        throw createHttpError(400, "missing_goal", "Field goal is required");
      }

      const userId = sanitizeUserId(body.user_id || "");
      const author = typeof body.author === "string" ? body.author : "";
      const domain = typeof body.domain === "string" ? body.domain : "";
      const from = typeof body.from === "string" ? body.from : "";
      const to = typeof body.to === "string" ? body.to : "";
      const limit = clampNumber(body.limit, 20, 1, 100);
      const offset = clampNumber(body.offset, 0, 0, 10_000);

      const result = await store.goalSearch({
        goal,
        userId: userId || null,
        author,
        domain,
        from,
        to,
        limit,
        offset
      });

      metrics.searchRequestsTotal.inc({
        type: "goal",
        strategy: result.strategy || "unknown"
      });
      metrics.searchDuration.observe(
        { type: "goal", strategy: result.strategy || "unknown" },
        (result.latency_ms || 0) / 1000
      );

      sendJson(res, 200, {
        ok: true,
        goal,
        total: result.total,
        items: result.items,
        grouped_results: result.grouped_results,
        goal_parse: result.goal_parse,
        steps: result.steps || [],
        route_score: result.route_score || null,
        next_steps: result.next_steps,
        strategy: result.strategy,
        latency_ms: result.latency_ms,
        warning: result.warning
      });
      return;
    }

    if (req.method === "GET" && routePath === "/discover") {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 8, 1, 20);
      const corpusLimit = clampNumber(requestUrl.searchParams.get("corpus_limit"), 1000, 50, 2500);
      const corpus = await store.getCorpus({ userId: userId || null, hardLimit: corpusLimit });

      sendJson(res, 200, buildDiscoverResponse({ items: corpus.items, limit }));
      return;
    }

    if (req.method === "GET" && routePath === "/clusters") {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const type = normalizeClusterType(requestUrl.searchParams.get("type") || "domain");
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 10, 1, 50);
      const corpusLimit = clampNumber(requestUrl.searchParams.get("corpus_limit"), 1000, 50, 2500);
      const corpus = await store.getCorpus({ userId: userId || null, hardLimit: corpusLimit });

      sendJson(res, 200, buildClustersResponse({ items: corpus.items, type, limit }));
      return;
    }

    if (req.method === "GET" && routePath === "/trending") {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 10, 1, 50);
      const corpusLimit = clampNumber(requestUrl.searchParams.get("corpus_limit"), 1000, 50, 2500);
      const corpus = await store.getCorpus({ userId: userId || null, hardLimit: corpusLimit });

      sendJson(res, 200, buildTrendingResponse({ items: corpus.items, limit }));
      return;
    }

    if (req.method === "GET" && /^\/related\/.+/.test(routePath)) {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const itemId = decodePathParam(routePath.replace(/^\/related\//, ""));
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 10, 1, 50);
      const corpusLimit = clampNumber(requestUrl.searchParams.get("corpus_limit"), 1000, 50, 2500);
      const target = await store.getBookmarkById({ id: itemId, userId: userId || null });

      if (!target) {
        throw createHttpError(404, "bookmark_not_found", "Bookmark not found");
      }

      const corpus = await store.getCorpus({ userId: userId || null, hardLimit: corpusLimit });
      const response = buildRelatedResponse({
        itemId,
        items: mergeTargetIntoCorpus(target, corpus.items),
        limit
      });

      if (!response) {
        throw createHttpError(404, "bookmark_not_found", "Bookmark not found");
      }

      sendJson(res, 200, response);
      return;
    }

    if (req.method === "GET" && /^\/graph\/.+/.test(routePath)) {
      const userId = sanitizeUserId(requestUrl.searchParams.get("user_id") || "");
      const itemId = decodePathParam(routePath.replace(/^\/graph\//, ""));
      const limit = clampNumber(requestUrl.searchParams.get("limit"), 12, 1, 50);
      const corpusLimit = clampNumber(requestUrl.searchParams.get("corpus_limit"), 1000, 50, 2500);
      const target = await store.getBookmarkById({ id: itemId, userId: userId || null });

      if (!target) {
        throw createHttpError(404, "bookmark_not_found", "Bookmark not found");
      }

      const corpus = await store.getCorpus({ userId: userId || null, hardLimit: corpusLimit });
      const response = buildGraphResponse({
        itemId,
        items: mergeTargetIntoCorpus(target, corpus.items),
        limit
      });

      if (!response) {
        throw createHttpError(404, "bookmark_not_found", "Bookmark not found");
      }

      sendJson(res, 200, response);
      return;
    }

    sendJson(res, 404, {
      ok: false,
      error: {
        code: "not_found",
        message: "Route not found"
      }
    });
  } catch (error) {
    const traceId = req.traceId || createServerTraceId("req");
    const statusCode =
      typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = error.code || "internal_error";
    const message =
      statusCode >= 500 ? "Internal server error" : error.message || "Request failed";
    const detail =
      statusCode >= 500 && error?.message && error.message !== message
        ? error.message
        : null;

    if (config.metricsEnabled) {
      let pathname = "/";
      try {
        pathname = new URL(req.url || "/", "http://internal").pathname;
      } catch {
        pathname = "/";
      }
      metrics.httpRequestErrorsTotal.inc({
        route: normalizeRoute(req.method, pathname),
        code
      });
    }

    console.error("[backend] request_failed", {
      trace_id: traceId,
      method: req.method,
      route: req.url,
      error: describeError(error)
    });

    sendJson(res, statusCode, {
      ok: false,
      trace_id: traceId,
      ...(typeof error.retryAfterSeconds === "number"
        ? { retry_after_seconds: error.retryAfterSeconds }
        : {}),
      error: {
        code,
        message,
        ...(detail ? { detail } : {})
      }
    });
  }
});

server.listen(config.port, () => {
  console.log(
    `[backend] listening on http://localhost:${config.port} | data file: ${config.dataFile}`
  );
});
