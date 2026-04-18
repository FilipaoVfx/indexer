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

export const config = {
  port: parseNumber(process.env.PORT, 8787),
  maxBatchSize: parseNumber(process.env.MAX_BATCH_SIZE, 50),
  dataFile:
    process.env.DATA_FILE ||
    path.resolve(__dirname, "..", "data", "bookmarks.json"),
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS || "*"),
  supabaseUrl: process.env.SUPABASE_URL,
  // The backend should prefer the service role key so DB-side RLS can stay enabled.
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
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
