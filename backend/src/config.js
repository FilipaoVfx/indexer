import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

export const config = {
  port: parseNumber(process.env.PORT, 8787),
  maxBatchSize: parseNumber(process.env.MAX_BATCH_SIZE, 50),
  dataFile:
    process.env.DATA_FILE ||
    path.resolve(__dirname, "..", "data", "bookmarks.json"),
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS || "*"),
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
};