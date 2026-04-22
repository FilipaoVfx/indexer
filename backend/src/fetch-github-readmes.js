import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(backendRoot, "..");

dotenv.config({ path: path.resolve(backendRoot, ".env") });

const DEFAULT_INPUT_FILE = path.resolve(backendRoot, "data", "github-repos.json");
const DEFAULT_OUTPUT_DIR = path.resolve(backendRoot, "data", "repo-readmes");
const METADATA_START = "<!-- indexbook-metadata:start -->";
const METADATA_END = "<!-- indexbook-metadata:end -->";

function parseArgs(argv) {
  const args = {
    concurrency: Number(process.env.GITHUB_README_CONCURRENCY || 4),
    decorateExisting: false,
    dryRun: false,
    input: process.env.GITHUB_REPOS_FILE || DEFAULT_INPUT_FILE,
    limit: 0,
    output: process.env.REPO_READMES_DIR || DEFAULT_OUTPUT_DIR,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--decorate-existing") {
      args.decorateExisting = true;
    } else if (arg.startsWith("--concurrency=")) {
      args.concurrency = Number(arg.slice("--concurrency=".length));
    } else if (arg.startsWith("--input=")) {
      args.input = path.resolve(arg.slice("--input=".length));
    } else if (arg.startsWith("--limit=")) {
      args.limit = Number(arg.slice("--limit=".length));
    } else if (arg.startsWith("--output=")) {
      args.output = path.resolve(arg.slice("--output=".length));
    }
  }

  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) {
    args.concurrency = 1;
  }
  args.concurrency = Math.floor(args.concurrency);

  if (!Number.isFinite(args.limit) || args.limit < 0) {
    args.limit = 0;
  }
  args.limit = Math.floor(args.limit);

  return args;
}

function toProjectPath(filePath) {
  return path.relative(projectRoot, filePath).replaceAll(path.sep, "/");
}

function normalizeRepo(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }

  const raw = value.trim();
  let owner;
  let repo;

  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return null;
    }

    if (!/^github\.com$/i.test(parsed.hostname.replace(/^www\./i, ""))) {
      return null;
    }

    const parts = parsed.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    [owner, repo] = parts;
  } else {
    const match = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match) return null;
    [, owner, repo] = match;
  }

  repo = repo?.replace(/\.git$/i, "");
  if (!owner || !repo) return null;

  return {
    fullName: `${owner}/${repo}`,
    name: repo,
    owner,
    url: `https://github.com/${owner}/${repo}`,
  };
}

function safeBaseName(fullName) {
  return fullName.replace(/[^\w.-]+/g, "__");
}

function flatReadmePath(outputDir, repo) {
  return path.join(outputDir, `${safeBaseName(repo.fullName)}.md`);
}

function decodeReadme(apiPayload) {
  if (apiPayload.encoding !== "base64" || !apiPayload.content) {
    throw new Error(`Unsupported README encoding: ${apiPayload.encoding || "unknown"}`);
  }

  return Buffer.from(apiPayload.content.replace(/\s/g, ""), "base64").toString("utf8");
}

function stripIndexbookMetadata(content) {
  const escapedStart = METADATA_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = METADATA_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markedPattern = new RegExp(
    `^${escapedStart}[\\s\\S]*?${escapedEnd}\\s*(?:---\\s*)?`,
    "i"
  );
  const legacyPattern = /^> IndexBook DB ID\(s\): .*\r?\n> Repo: .*\r?\n\s*---\s*/i;

  return content.replace(markedPattern, "").replace(legacyPattern, "").replace(/^\s+/, "");
}

function withIndexbookMetadata(repo, content) {
  const ids = repo.ids.map((id) => `\`${id}\``).join(", ");

  return [
    METADATA_START,
    `> IndexBook DB ID(s): ${ids}`,
    `> Repo: ${repo.url}`,
    METADATA_END,
    "",
    "---",
    "",
    stripIndexbookMetadata(content),
  ].join("\n");
}

async function loadRepoEntries(inputFile) {
  const raw = await fs.readFile(inputFile, "utf8");
  const entries = JSON.parse(raw);

  if (!Array.isArray(entries)) {
    throw new Error(`Expected an array in ${inputFile}`);
  }

  const invalid = [];
  const repos = new Map();

  entries.forEach((entry, index) => {
    const repo = normalizeRepo(entry?.repo);
    const id = typeof entry?.id === "string" ? entry.id : null;

    if (!repo || !id) {
      invalid.push({ entry, index });
      return;
    }

    const key = repo.fullName.toLowerCase();
    if (!repos.has(key)) {
      repos.set(key, {
        ...repo,
        ids: new Set(),
      });
    }

    repos.get(key).ids.add(id);
  });

  return {
    invalid,
    repos: [...repos.values()].map((repo) => ({
      ...repo,
      ids: [...repo.ids].sort(),
    })),
    sourceRows: entries.length,
  };
}

async function fetchGithubJson(apiPath, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "indexbook-readme-fetcher",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${apiPath}`, { headers });
  const body = await response.text();
  const payload = body ? JSON.parse(body) : null;

  if (!response.ok) {
    const message = payload?.message || response.statusText || "GitHub request failed";
    const error = new Error(message);
    error.status = response.status;
    error.rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    error.rateLimitReset = response.headers.get("x-ratelimit-reset");
    throw error;
  }

  return payload;
}

async function findExistingReadmePath(repo, outputDir) {
  const flatPath = flatReadmePath(outputDir, repo);

  try {
    const stat = await fs.stat(flatPath);
    if (stat.isFile()) return flatPath;
  } catch {
    // Fall through to legacy per-repo folder lookup.
  }

  const legacyRepoDir = path.join(outputDir, safeBaseName(repo.fullName));
  let files;
  try {
    files = await fs.readdir(legacyRepoDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const readme = files
    .filter((file) => file.isFile() && /^readme(?:\..+)?$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0];

  return readme ? path.join(legacyRepoDir, readme.name) : null;
}

async function writeFlatReadme(repo, outputDir, content) {
  const readmePath = flatReadmePath(outputDir, repo);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(readmePath, withIndexbookMetadata(repo, content), "utf8");

  return {
    fullName: repo.fullName,
    ids: repo.ids,
    readmePath: toProjectPath(readmePath),
    repo: repo.url,
    status: "ok",
  };
}

async function decorateExistingReadme(repo, outputDir) {
  const existingPath = await findExistingReadmePath(repo, outputDir);

  if (!existingPath) {
    return {
      error: "README file not found",
      fullName: repo.fullName,
      ids: repo.ids,
      repo: repo.url,
      status: "missing_readme",
    };
  }

  const raw = await fs.readFile(existingPath, "utf8");
  return writeFlatReadme(repo, outputDir, raw);
}

async function fetchReadme(repo, outputDir, token) {
  try {
    const payload = await fetchGithubJson(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/readme`,
      token
    );
    return writeFlatReadme(repo, outputDir, decodeReadme(payload));
  } catch (error) {
    return {
      error: {
        message: error.message,
        rateLimitRemaining: error.rateLimitRemaining
          ? Number(error.rateLimitRemaining)
          : undefined,
        rateLimitReset: error.rateLimitReset
          ? new Date(Number(error.rateLimitReset) * 1000).toISOString()
          : undefined,
        status: error.status,
      },
      fullName: repo.fullName,
      ids: repo.ids,
      repo: repo.url,
      status: error.status === 404 ? "not_found" : "error",
    };
  }
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runWorker()
  );
  await Promise.all(workers);
  return results;
}

function printSummary(results) {
  const ok = results.filter((item) => item.status === "ok").length;
  const failed = results.length - ok;

  console.log(`OK: ${ok}`);
  console.log(`Failed: ${failed}`);

  for (const result of results.filter((item) => item.status !== "ok")) {
    const message = result.error?.message || result.error || result.status;
    console.log(`- ${result.fullName}: ${message}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const { invalid, repos, sourceRows } = await loadRepoEntries(args.input);
  const selectedRepos = args.limit > 0 ? repos.slice(0, args.limit) : repos;

  console.log(`Input: ${toProjectPath(args.input)}`);
  console.log(`Rows: ${sourceRows}`);
  console.log(`Unique repos: ${repos.length}`);
  console.log(`Output: ${toProjectPath(args.output)}`);
  if (invalid.length > 0) {
    console.log(`Invalid rows skipped: ${invalid.length}`);
  }

  if (args.dryRun) {
    console.log("Dry run enabled; no files were written.");
    return;
  }

  if (!args.decorateExisting && !token) {
    console.warn("GITHUB_TOKEN/GH_TOKEN is not set; using unauthenticated GitHub API requests.");
  }

  const results = await runPool(selectedRepos, args.concurrency, async (repo, index) => {
    const position = `${index + 1}/${selectedRepos.length}`;
    process.stdout.write(`[${position}] ${repo.fullName} ... `);
    const result = args.decorateExisting
      ? await decorateExistingReadme(repo, args.output)
      : await fetchReadme(repo, args.output, token);
    console.log(result.status);
    return result;
  });

  printSummary(results);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
