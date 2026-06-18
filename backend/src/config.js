import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envFilePath = path.resolve(__dirname, "..", ".env");

dotenv.config({ path: envFilePath });

function parseOrigins(value) {
  if (!value || value.trim() === "*") {
    return ["*"];
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseTableName(value, fallback) {
  const tableName = String(value || fallback || "").trim();

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(
      `Invalid BOOKMARKS_TABLE "${tableName}". Use an unqualified table name like bookmarks_ai.`
    );
  }

  return tableName;
}

function parseBookmarkDedupeScope(value, fallback) {
  const normalized = String(value || fallback || "").trim().toLowerCase();

  if (["global", "tweet", "tweet_id"].includes(normalized)) {
    return "global";
  }

  if (["per_user", "user", "user_id"].includes(normalized)) {
    return "per_user";
  }

  throw new Error(
    `Invalid BOOKMARK_DEDUPE_SCOPE "${normalized}". Use "global" or "per_user".`
  );
}

function parseMetricsPath(value, fallback) {
  const metricsPath = String(value || fallback || "/metrics").trim();
  if (!metricsPath.startsWith("/")) {
    throw new Error(
      `Invalid METRICS_PATH "${metricsPath}". It must start with "/" (e.g. /metrics).`
    );
  }
  return metricsPath;
}

const bookmarksTable = parseTableName(process.env.BOOKMARKS_TABLE, "bookmarks");
const bookmarkDedupeScope = parseBookmarkDedupeScope(
  process.env.BOOKMARK_DEDUPE_SCOPE,
  bookmarksTable === "bookmarks" ? "per_user" : "global"
);
const enableBookmarkSideEffects = parseBoolean(
  process.env.BOOKMARKS_ENABLE_SIDE_EFFECTS,
  bookmarksTable === "bookmarks"
);

export const config = {
  port: parseNumber(process.env.PORT, 8787),
  maxBatchSize: parseNumber(process.env.MAX_BATCH_SIZE, 50),
  githubReadmeMaxChars: parseNumber(process.env.GITHUB_README_MAX_CHARS, 300000),
  githubReadmeMaxPerBatch: parseNumber(process.env.GITHUB_README_MAX_PER_BATCH, 8),
  githubReadmeTtlHours: parseNumber(process.env.GITHUB_README_TTL_HOURS, 168),
  githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  dataFile:
    process.env.DATA_FILE ||
    path.resolve(__dirname, "..", "data", "bookmarks.json"),
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS || "*"),
  supabaseUrl: process.env.SUPABASE_URL,
  // The backend should prefer the service role key so DB-side RLS can stay enabled.
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  bookmarksTable,
  bookmarkDedupeScope,
  enableBookmarkSideEffects,
  // Observability: Prometheus metrics endpoint.
  metricsEnabled: parseBoolean(process.env.METRICS_ENABLED, true),
  metricsPath: parseMetricsPath(process.env.METRICS_PATH, "/metrics"),
  // When set, GET <metricsPath> requires `Authorization: Bearer <token>`.
  // Strongly recommended when the backend runs on a host separate from
  // Prometheus and /metrics is reachable over the public internet.
  metricsToken: (process.env.METRICS_TOKEN || "").trim()
};

export function validateConfig() {
  const missing = [];

  if (!config.supabaseUrl) {
    missing.push("SUPABASE_URL");
  }

  if (!config.supabaseKey) {
    missing.push("SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables in ${envFilePath}: ${missing.join(", ")}`
    );
  }
}
