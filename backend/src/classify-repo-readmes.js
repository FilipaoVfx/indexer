import { config, validateConfig } from "./config.js";
import { BookmarkStore } from "./store.js";

validateConfig();

function parseArgs(argv) {
  const args = {
    force: false,
    limit: 0,
    repo: "",
  };

  for (const arg of argv) {
    if (arg === "--force") {
      args.force = true;
    } else if (arg.startsWith("--limit=")) {
      args.limit = Math.max(0, Number(arg.slice("--limit=".length)) || 0);
    } else if (arg.startsWith("--repo=")) {
      args.repo = arg.slice("--repo=".length).trim().toLowerCase();
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = new BookmarkStore(config);
  await store.init();

  let queryBuilder = store.supabase
    .from("github_repo_readmes")
    .select("repo_slug,owner,repo,repo_url,status,content,content_chars,updated_at")
    .order("updated_at", { ascending: false });

  if (args.repo) {
    queryBuilder = queryBuilder.eq("repo_slug", args.repo);
  }

  if (args.limit > 0) {
    queryBuilder = queryBuilder.limit(args.limit);
  }

  const { data, error } = await queryBuilder;
  if (error) {
    throw new Error(`Failed to load GitHub READMEs: ${error.message}`);
  }

  const rows = Array.isArray(data) ? data : [];
  const result = await store.ensureRepoClassificationsForReadmeRows(rows, {
    force: args.force,
  });

  console.log(
    JSON.stringify(
      {
        total_readmes: rows.length,
        refreshed: result.refreshed,
        warning: result.warning || null,
        repo: args.repo || null,
        force: args.force,
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
