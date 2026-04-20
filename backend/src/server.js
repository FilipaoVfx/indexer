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

validateConfig();

const store = new BookmarkStore(config);
await store.init();

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

function mergeTargetIntoCorpus(target, corpusItems) {
  if (!target) return corpusItems;
  if (corpusItems.some((item) => item.id === target.id)) {
    return corpusItems;
  }

  return [target, ...corpusItems];
}

const server = http.createServer(async (req, res) => {
  try {
    setCorsHeaders(req, res, config.allowedOrigins);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const routePath = requestUrl.pathname;

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

    if (req.method === "POST" && routePath === "/api/bookmarks/batch") {
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

      sendJson(res, 200, {
        ok: true,
        trace_id: traceId,
        user_id: userId,
        sync_id: syncId,
        ...summary
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

      sendJson(res, 200, {
        ok: true,
        goal,
        total: result.total,
        items: result.items,
        grouped_results: result.grouped_results,
        goal_parse: result.goal_parse,
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

    console.error("[backend] request_failed", {
      trace_id: traceId,
      method: req.method,
      route: req.url,
      error: describeError(error)
    });

    sendJson(res, statusCode, {
      ok: false,
      trace_id: traceId,
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
