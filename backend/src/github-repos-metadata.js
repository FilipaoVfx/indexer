import { splitGithubRepoSlug } from "./github-readmes.js";

// Mapea el estado del README cacheado (github_repo_readmes.status) al estado
// liviano que expone github_repositories.readme_status.
export function mapReadmeStatusToRepo(readmeStatus) {
  const status = String(readmeStatus || "").trim().toLowerCase();
  if (status === "ok") return "indexed";
  if (status === "not_found") return "skipped";
  if (status === "error") return "failed";
  return "pending";
}

function log2p1(value) {
  const n = Math.max(0, Number(value) || 0);
  return Math.log2(1 + n);
}

// Recencia: ~3 si se empujó hoy, decae a 0 a lo largo de ~9 meses.
function recencyScore(pushedAt) {
  if (!pushedAt) return 0;
  const pushed = new Date(pushedAt).getTime();
  if (!Number.isFinite(pushed)) return 0;
  const days = (Date.now() - pushed) / 86_400_000;
  return Math.max(0, 3 - days / 90);
}

// Score de prioridad (§6 del requerimiento). Determina qué repos se indexan
// primero. Pesos conservadores; pueden moverse a config si hace falta.
export function computeRepoPriority({
  stars = 0,
  forks = 0,
  pushedAt = null,
  topicsCount = 0,
  hasReadme = false,
  bookmarkCount = 0,
} = {}) {
  const score =
    2.0 * log2p1(stars) +
    1.5 * log2p1(forks) +
    1.0 * recencyScore(pushedAt) +
    0.5 * (topicsCount > 0 ? 1 : 0) +
    1.0 * (hasReadme ? 1 : 0) +
    1.2 * log2p1(bookmarkCount);
  return Math.round(score * 1000) / 1000;
}

// Trae metadata liviana de un repo desde la API de GitHub.
// No descarga el README (eso sigue en fetchGithubReadmeRow). Devuelve
// { ...repoInfo, missing|error, ...campos } sin lanzar para errores HTTP.
export async function fetchRepoMetadata(repoSlug, options = {}) {
  const repoInfo = splitGithubRepoSlug(repoSlug);
  if (!repoInfo) {
    throw new Error(`Invalid GitHub repo slug: ${repoSlug}`);
  }

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "indexbook-repo-metadata",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (options.githubToken) {
    headers.Authorization = `Bearer ${options.githubToken}`;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(repoInfo.owner)}/${encodeURIComponent(repoInfo.repo)}`,
      { headers }
    );
    const body = await response.text();
    const payload = body ? JSON.parse(body) : null;

    if (!response.ok) {
      return {
        ...repoInfo,
        ok: false,
        missing: response.status === 404,
        error_status: response.status,
        error_message: payload?.message || response.statusText || "GitHub request failed",
      };
    }

    return {
      ...repoInfo,
      ok: true,
      github_id: Number(payload?.id) || null,
      description: payload?.description || null,
      language: payload?.language || null,
      topics: Array.isArray(payload?.topics) ? payload.topics : [],
      stars: Number(payload?.stargazers_count) || 0,
      forks: Number(payload?.forks_count) || 0,
      pushed_at: payload?.pushed_at || null,
    };
  } catch (error) {
    return {
      ...repoInfo,
      ok: false,
      missing: false,
      error_status: null,
      error_message: error?.message || String(error),
    };
  }
}
