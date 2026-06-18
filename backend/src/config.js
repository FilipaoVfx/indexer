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

function parseBool(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
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

export const config = {
  port: parseNumber(process.env.PORT, 8787),
  maxBatchSize: parseNumber(process.env.MAX_BATCH_SIZE, 50),
  githubReadmeMaxChars: parseNumber(process.env.GITHUB_README_MAX_CHARS, 300000),
  githubReadmeMaxPerBatch: parseNumber(process.env.GITHUB_README_MAX_PER_BATCH, 8),
  githubReadmeTtlHours: parseNumber(process.env.GITHUB_README_TTL_HOURS, 168),
  // Lazy por defecto: la ingesta marca repos como 'pending' y el README se
  // descarga al verlo o vía backfill. true restaura el fetch en el request path.
  githubReadmeEagerFetch: parseBool(process.env.GITHUB_README_EAGER_FETCH, false),
  githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  dataFile:
    process.env.DATA_FILE ||
    path.resolve(__dirname, "..", "data", "bookmarks.json"),
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS || "*"),
  supabaseUrl: process.env.SUPABASE_URL,
  // The backend should prefer the service role key so DB-side RLS can stay enabled.
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  // Observability: Prometheus metrics endpoint.
  metricsEnabled: parseBool(process.env.METRICS_ENABLED, true),
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
