import http from "node:http";
import { URL } from "node:url";
import { config, validateConfig } from "./config.js";
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
      const total = await store.count();
      sendJson(res, 200, {
        ok: true,
        service: "x-bookmarks-backend",
        timestamp: new Date().toISOString(),
        total_bookmarks: total
      });
      return;
    }

    if (req.method === "POST" && routePath === "/api/bookmarks/batch") {
      const body = await parseJsonBody(req);

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

    sendJson(res, 404, {
      ok: false,
      error: {
        code: "not_found",
        message: "Route not found"
      }
    });
  } catch (error) {
    const statusCode =
      typeof error.statusCode === "number" ? error.statusCode : 500;
    const code = error.code || "internal_error";
    const message =
      statusCode >= 500 ? "Internal server error" : error.message || "Request failed";

    sendJson(res, statusCode, {
      ok: false,
      error: {
        code,
        message
      }
    });
  }
});

server.listen(config.port, () => {
  console.log(
    `[backend] listening on http://localhost:${config.port} | data file: ${config.dataFile}`
  );
});
