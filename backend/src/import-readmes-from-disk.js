/**
 * Import the `.md` READMEs from `backend/data/repo-readmes/` into Supabase,
 * keeping `github_repo_readmes` and `bookmark_github_repos` consistent.
 *
 * Each file's header looks like:
 *
 *     <!-- indexbook-metadata:start -->
 *     > IndexBook DB ID(s): `juan:204...`, `local-user:200...`
 *     > Repo: https://github.com/owner/repo
 *     <!-- indexbook-metadata:end -->
 *     ---
 *     (actual README content follows)
 *
 * Flow:
 *   1. Parse every .md file in the input dir; extract bookmark_ids + repo url.
 *   2. Strip the metadata header → canonical README content.
 *   3. Upsert parent rows into `github_repo_readmes` (status=ok, content, …).
 *   4. Validate the referenced bookmark_ids exist in `bookmarks` (FK safety).
 *   5. Upsert the pivot rows into `bookmark_github_repos` (bookmark_id, user_id,
 *      repo_slug) — skipping any bookmark_id that does not exist.
 *
 * Usage:
 *   node src/import-readmes-from-disk.js            # dry-run by default
 *   node src/import-readmes-from-disk.js --apply    # commit to DB
 *   node src/import-readmes-from-disk.js --input=/custom/dir
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { splitGithubRepoSlug } from "./github-readmes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.resolve(backendRoot, ".env") });

const DEFAULT_INPUT_DIR = path.resolve(backendRoot, "data", "repo-readmes");
const METADATA_START = "<!-- indexbook-metadata:start -->";
const METADATA_END = "<!-- indexbook-metadata:end -->";
const ID_CHUNK = 500;
const UPSERT_CHUNK = 200;

function parseArgs(argv) {
  const args = {
    apply: false,
    input: DEFAULT_INPUT_DIR,
    yes: false,
  };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg.startsWith("--input=")) args.input = path.resolve(arg.slice("--input=".length));
  }
  return args;
}

function stripIndexbookMetadata(content) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marked = new RegExp(
    `^${esc(METADATA_START)}[\\s\\S]*?${esc(METADATA_END)}\\s*(?:---\\s*)?`,
    "i"
  );
  const legacy = /^> IndexBook DB ID\(s\): .*\r?\n> Repo: .*\r?\n\s*---\s*/i;
  return content.replace(marked, "").replace(legacy, "").replace(/^\s+/, "");
}

function parseMetadataHeader(raw) {
  // The header is either the marked variant or the legacy variant.
  const idLine = raw.match(/^> IndexBook DB ID\(s\):\s*(.+)$/m);
  const repoLine = raw.match(/^> Repo:\s*(\S+)\s*$/m);

  const ids = idLine
    ? [...idLine[1].matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean)
    : [];

  const repoUrl = repoLine ? repoLine[1].trim() : "";
  return { ids, repoUrl };
}

function userIdFromBookmarkId(bookmarkId) {
  const idx = bookmarkId.indexOf(":");
  if (idx <= 0) return null;
  return bookmarkId.slice(0, idx);
}

async function loadFilesFromDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => path.join(dir, e.name))
    .sort();
}

async function chunkInQueries(supabase, ids) {
  // Chunk an IN(...) select to avoid URL/query limits.
  const out = new Set();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const { data, error } = await supabase
      .from("bookmarks")
      .select("id")
      .in("id", chunk);
    if (error) throw new Error(`bookmarks lookup failed: ${error.message}`);
    for (const row of data || []) out.add(row.id);
  }
  return out;
}

async function upsertInChunks(supabase, table, rows, onConflict) {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK);
    const { error } = await supabase.from(table).upsert(chunk, { onConflict });
    if (error) {
      throw new Error(
        `upsert into ${table} failed at offset ${i}: ${error.message}`
      );
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) must be set"
    );
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  console.log(`Input dir: ${args.input}`);
  console.log(`Mode: ${args.apply ? "APPLY (writes to DB)" : "DRY-RUN"}\n`);

  const files = await loadFilesFromDir(args.input);
  console.log(`Markdown files: ${files.length}\n`);

  const readmeRows = [];
  const pivotRows = [];
  const now = new Date().toISOString();
  const issues = [];

  for (const file of files) {
    const baseName = path.basename(file);
    const raw = await fs.readFile(file, "utf8");
    const { ids, repoUrl } = parseMetadataHeader(raw);

    if (!repoUrl) {
      issues.push({ file: baseName, kind: "missing_repo_url" });
      continue;
    }
    if (ids.length === 0) {
      issues.push({ file: baseName, kind: "missing_bookmark_ids" });
      continue;
    }

    const repo = splitGithubRepoSlug(repoUrl);
    if (!repo) {
      issues.push({ file: baseName, kind: "invalid_repo_slug", repoUrl });
      continue;
    }

    const content = stripIndexbookMetadata(raw);
    const contentChars = content.length;
    const sizeBytes = Buffer.byteLength(content, "utf8");

    readmeRows.push({
      repo_slug: repo.repo_slug,
      owner: repo.owner,
      repo: repo.repo,
      repo_url: repo.repo_url,
      status: "ok",
      readme_name: "README.md",
      readme_path: null,
      readme_sha: null,
      readme_html_url: `${repo.repo_url}/blob/HEAD/README.md`,
      readme_download_url: null,
      content,
      content_chars: contentChars,
      content_truncated: false,
      size_bytes: sizeBytes,
      fetched_at: now,
      last_requested_at: now,
      error_message: null,
      error_status: null,
      updated_at: now,
    });

    for (const bookmarkId of ids) {
      const userId = userIdFromBookmarkId(bookmarkId);
      if (!userId) {
        issues.push({ file: baseName, kind: "invalid_bookmark_id", bookmarkId });
        continue;
      }
      pivotRows.push({
        bookmark_id: bookmarkId,
        user_id: userId,
        repo_slug: repo.repo_slug,
        created_at: now,
      });
    }
  }

  // Deduplicate: one .md file can map to the same repo twice? defensive anyway.
  const readmeBySlug = new Map();
  for (const row of readmeRows) readmeBySlug.set(row.repo_slug, row);
  const dedupReadmes = [...readmeBySlug.values()];

  const pivotBySlug = new Map();
  for (const row of pivotRows) {
    const key = `${row.bookmark_id}::${row.repo_slug}`;
    pivotBySlug.set(key, row);
  }
  const dedupPivot = [...pivotBySlug.values()];

  // FK safety: bookmark_ids must exist.
  const bookmarkIds = [...new Set(dedupPivot.map((r) => r.bookmark_id))];
  console.log(`Unique repos to upsert: ${dedupReadmes.length}`);
  console.log(`Unique (bookmark_id, repo_slug) pivots: ${dedupPivot.length}`);
  console.log(`Unique bookmark_ids referenced: ${bookmarkIds.length}`);

  console.log("Validating bookmark_ids against bookmarks table...");
  const existingBookmarkIds = await chunkInQueries(supabase, bookmarkIds);
  const missingBookmarkIds = bookmarkIds.filter(
    (id) => !existingBookmarkIds.has(id)
  );
  console.log(`  Existing: ${existingBookmarkIds.size}`);
  console.log(`  Missing : ${missingBookmarkIds.length}`);

  if (missingBookmarkIds.length > 0) {
    console.log("  (these will be SKIPPED to avoid FK violations)");
    for (const id of missingBookmarkIds.slice(0, 10)) console.log(`   - ${id}`);
    if (missingBookmarkIds.length > 10) {
      console.log(`   ... (${missingBookmarkIds.length - 10} more)`);
    }
  }

  const finalPivot = dedupPivot.filter((r) => existingBookmarkIds.has(r.bookmark_id));
  console.log(`Final pivot rows after FK filter: ${finalPivot.length}`);

  if (issues.length > 0) {
    console.log(`\nParsing issues: ${issues.length}`);
    for (const issue of issues.slice(0, 10)) {
      console.log(`  - ${issue.kind}: ${issue.file}${issue.repoUrl ? " | " + issue.repoUrl : ""}${issue.bookmarkId ? " | " + issue.bookmarkId : ""}`);
    }
    if (issues.length > 10) {
      console.log(`  ... (${issues.length - 10} more)`);
    }
  }

  if (dedupReadmes[0]) {
    const sample = dedupReadmes[0];
    console.log("\nSample readme row:");
    console.log({
      repo_slug: sample.repo_slug,
      owner: sample.owner,
      repo: sample.repo,
      repo_url: sample.repo_url,
      status: sample.status,
      content_chars: sample.content_chars,
      size_bytes: sample.size_bytes,
    });
  }

  if (!args.apply) {
    console.log("\nDry run — no writes performed. Re-run with --apply to commit.");
    return;
  }

  console.log("\nUpserting github_repo_readmes (parent)...");
  await upsertInChunks(supabase, "github_repo_readmes", dedupReadmes, "repo_slug");
  console.log(`  ok: ${dedupReadmes.length} rows`);

  console.log("Upserting bookmark_github_repos (pivot)...");
  await upsertInChunks(
    supabase,
    "bookmark_github_repos",
    finalPivot,
    "bookmark_id,repo_slug"
  );
  console.log(`  ok: ${finalPivot.length} rows`);

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
