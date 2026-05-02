import { config, validateConfig } from "./config.js";
import { BookmarkStore } from "./store.js";

validateConfig();

function parseArgs(argv) {
  const args = {
    includeNotFound: false,
    limit: 0,
  };

  for (const arg of argv) {
    if (arg === "--include-not-found") {
      args.includeNotFound = true;
    } else if (arg.startsWith("--limit=")) {
      args.limit = Math.max(0, Number(arg.slice("--limit=".length)) || 0);
    }
  }

  return args;
}

function chunkArray(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new BookmarkStore(config);
  await store.init();

  const { data, error } = await store.supabase
    .from("bookmark_github_repos")
    .select(`
      repo_slug,
      github_repo_readmes (
        repo_slug,
        status
      )
    `);

  if (error) {
    throw new Error(`Failed to inspect repo/readme coverage: ${error.message}`);
  }

  const targetSlugs = [
    ...new Set(
      (data || [])
        .map((row) => {
          const repoSlug = String(row?.repo_slug || "").trim().toLowerCase();
          const readmeRow = Array.isArray(row?.github_repo_readmes)
            ? row.github_repo_readmes[0]
            : row?.github_repo_readmes;
          const status = String(readmeRow?.status || "").trim().toLowerCase();

          if (!repoSlug) return "";
          if (!readmeRow) return repoSlug;
          if (status === "pending" || status === "error") return repoSlug;
          if (args.includeNotFound && status === "not_found") return repoSlug;
          return "";
        })
        .filter(Boolean)
    )
  ];

  const selectedSlugs = args.limit > 0 ? targetSlugs.slice(0, args.limit) : targetSlugs;
  const batches = chunkArray(
    selectedSlugs,
    Math.max(1, Number(config.githubReadmeMaxPerBatch) || 8)
  );

  let fetched = 0;
  let skipped = 0;
  const warnings = [];

  for (const batch of batches) {
    const result = await store.fetchGithubReadmesForSlugs(batch);
    fetched += Number(result?.fetched || 0);
    skipped += Number(result?.skipped || 0);
    if (result?.warning) warnings.push(result.warning);
  }

  console.log(
    JSON.stringify(
      {
        total_candidates: targetSlugs.length,
        processed: selectedSlugs.length,
        fetched,
        skipped,
        warnings: [...new Set(warnings.filter(Boolean))],
        include_not_found: args.includeNotFound,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
