import { config, validateConfig } from "./config.js";
import { BookmarkStore } from "./store.js";
import {
  fetchRepoMetadata,
  computeRepoPriority,
  mapReadmeStatusToRepo
} from "./github-repos-metadata.js";

validateConfig();

function parseArgs(argv) {
  const args = {
    limit: 0,        // 0 = enriquecer todos
    onlyMissing: false, // solo repos sin metadata_fetched_at
    dryRun: false
  };

  for (const arg of argv) {
    if (arg === "--only-missing") {
      args.onlyMissing = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
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

  // 1. Inventario de repos conocidos (slug + estado del README cacheado).
  const { data: readmeRows, error: readmeError } = await store.supabase
    .from("github_repo_readmes")
    .select("repo_slug,status");
  if (readmeError) {
    throw new Error(`Failed to read github_repo_readmes: ${readmeError.message}`);
  }

  const statusBySlug = new Map();
  for (const row of readmeRows || []) {
    const slug = String(row?.repo_slug || "").trim().toLowerCase();
    if (slug) statusBySlug.set(slug, String(row?.status || "").trim().toLowerCase());
  }

  // 2. Conteo de bookmarks que mencionan cada repo (señal de prioridad propia).
  const { data: mentionRows, error: mentionError } = await store.supabase
    .from("bookmark_github_repos")
    .select("repo_slug");
  if (mentionError) {
    throw new Error(`Failed to read bookmark_github_repos: ${mentionError.message}`);
  }

  const bookmarkCountBySlug = new Map();
  for (const row of mentionRows || []) {
    const slug = String(row?.repo_slug || "").trim().toLowerCase();
    if (!slug) continue;
    bookmarkCountBySlug.set(slug, (bookmarkCountBySlug.get(slug) || 0) + 1);
  }

  const allSlugs = [...new Set([...statusBySlug.keys(), ...bookmarkCountBySlug.keys()])];

  // 3. Siembra filas livianas para TODOS (barato, sin llamar a GitHub).
  if (!args.dryRun) {
    const ensureWarning = await store.ensureRepositoryRows(allSlugs);
    if (ensureWarning) {
      console.warn(JSON.stringify({ warning: ensureWarning }, null, 2));
      return;
    }
  }

  // 4. Determina qué repos enriquecer con metadata de GitHub.
  let targets = allSlugs;
  if (args.onlyMissing && !args.dryRun) {
    const { data: existing, error: existingError } = await store.supabase
      .from("github_repositories")
      .select("repo_slug,metadata_fetched_at")
      .in("repo_slug", allSlugs.slice(0, 1000));
    if (existingError) {
      throw new Error(`Failed to read github_repositories: ${existingError.message}`);
    }
    const enriched = new Set(
      (existing || [])
        .filter((row) => row.metadata_fetched_at)
        .map((row) => row.repo_slug)
    );
    targets = allSlugs.filter((slug) => !enriched.has(slug));
  }

  if (args.limit > 0) {
    targets = targets.slice(0, args.limit);
  }

  // 5. Enriquece secuencialmente (respeta el rate limit de GitHub).
  const now = new Date().toISOString();
  const rows = [];
  let metadataOk = 0;
  let metadataFailed = 0;

  for (const slug of targets) {
    const status = statusBySlug.get(slug) || "";
    const bookmarkCount = bookmarkCountBySlug.get(slug) || 0;
    const meta = await fetchRepoMetadata(slug, { githubToken: config.githubToken });

    if (meta.ok) {
      metadataOk += 1;
    } else {
      metadataFailed += 1;
    }

    const priority = computeRepoPriority({
      stars: meta.stars || 0,
      forks: meta.forks || 0,
      pushedAt: meta.pushed_at || null,
      topicsCount: Array.isArray(meta.topics) ? meta.topics.length : 0,
      hasReadme: status === "ok",
      bookmarkCount
    });

    rows.push({
      repo_slug: meta.repo_slug,
      github_id: meta.github_id || null,
      owner: meta.owner,
      repo: meta.repo,
      url: meta.repo_url,
      description: meta.description || null,
      language: meta.language || null,
      topics: Array.isArray(meta.topics) ? meta.topics : [],
      stars: meta.stars || 0,
      forks: meta.forks || 0,
      pushed_at: meta.pushed_at || null,
      source: "bookmark",
      priority,
      readme_status: mapReadmeStatusToRepo(status),
      metadata_fetched_at: now,
      updated_at: now
    });
  }

  let upserted = 0;
  const warnings = [];
  if (!args.dryRun) {
    for (const batch of chunkArray(rows, 50)) {
      const result = await store.upsertRepositoryMetadata(batch);
      upserted += result.upserted;
      if (result.warning) warnings.push(result.warning);
    }
  }

  console.log(
    JSON.stringify(
      {
        known_repos: allSlugs.length,
        seeded: args.dryRun ? 0 : allSlugs.length,
        enrich_targets: targets.length,
        metadata_ok: metadataOk,
        metadata_failed: metadataFailed,
        upserted,
        dry_run: args.dryRun,
        only_missing: args.onlyMissing,
        warnings: [...new Set(warnings.filter(Boolean))]
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
