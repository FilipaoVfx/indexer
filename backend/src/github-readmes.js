const GITHUB_RESERVED_SEGMENTS = new Set([
  "about", "account", "apps", "blog", "business", "collections", "contact",
  "customer-stories", "enterprise", "events", "explore", "features", "gist",
  "github", "join", "login", "marketplace", "new", "notifications", "orgs",
  "organizations", "pricing", "pulls", "search", "settings", "showcases",
  "site", "sponsors", "stars", "topics", "trending", "watching",
]);

const GITHUB_REPO_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?=\.git\b|[/?#\s)\]}>,"'<]|$)/gi;

function cleanRepoSegment(value) {
  return String(value || "")
    .trim()
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+$/g, "");
}

export function normalizeGithubRepoSlug(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let owner = "";
  let repo = "";

  if (/github\.com/i.test(raw)) {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const url = new URL(candidate);
      if (!/(^|\.)github\.com$/i.test(url.hostname)) return "";
      const parts = url.pathname.split("/").filter(Boolean);
      owner = cleanRepoSegment(parts[0]);
      repo = cleanRepoSegment(parts[1]);
    } catch (_error) {
      return "";
    }
  } else {
    const match = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match) return "";
    owner = cleanRepoSegment(match[1]);
    repo = cleanRepoSegment(match[2]);
  }

  if (!owner || !repo) return "";
  if (GITHUB_RESERVED_SEGMENTS.has(owner.toLowerCase())) return "";

  return `${owner}/${repo}`.toLowerCase();
}

export function splitGithubRepoSlug(repoSlug) {
  const slug = normalizeGithubRepoSlug(repoSlug);
  if (!slug) return null;
  const [owner, repo] = slug.split("/");
  return {
    owner,
    repo,
    repo_slug: slug,
    repo_url: `https://github.com/${owner}/${repo}`,
  };
}

export function extractGithubRepoSlugsFromText(value) {
  const text = String(value || "");
  const slugs = new Set();
  let match = null;

  GITHUB_REPO_URL_RE.lastIndex = 0;
  while ((match = GITHUB_REPO_URL_RE.exec(text)) !== null) {
    const slug = normalizeGithubRepoSlug(`${match[1]}/${match[2]}`);
    if (slug) slugs.add(slug);
  }

  return [...slugs];
}

export function extractGithubRepoSlugsFromBookmarkLike(bookmark) {
  const values = [
    bookmark?.source_url,
    bookmark?.canonical_url,
    bookmark?.text_content,
    bookmark?.summary,
    ...(Array.isArray(bookmark?.links) ? bookmark.links : []),
    ...(Array.isArray(bookmark?.first_comment_links) ? bookmark.first_comment_links : []),
    ...(Array.isArray(bookmark?.repo_slugs) ? bookmark.repo_slugs : []),
  ];

  const slugs = new Set();
  for (const value of values) {
    const normalized = normalizeGithubRepoSlug(value);
    if (normalized) {
      slugs.add(normalized);
      continue;
    }

    for (const slug of extractGithubRepoSlugsFromText(value)) {
      slugs.add(slug);
    }
  }

  return [...slugs].sort();
}

function truncateContent(content, maxChars) {
  const limit = Number(maxChars);
  if (!Number.isFinite(limit) || limit <= 0 || content.length <= limit) {
    return {
      content,
      content_truncated: false,
    };
  }

  return {
    content: content.slice(0, limit),
    content_truncated: true,
  };
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`raw_readme_http_${response.status}`);
  }
  return response.text();
}

export async function fetchGithubReadmeRow(repoSlug, options = {}) {
  const repoInfo = splitGithubRepoSlug(repoSlug);
  if (!repoInfo) {
    throw new Error(`Invalid GitHub repo slug: ${repoSlug}`);
  }

  const now = new Date().toISOString();
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "indexbook-readme-fetcher",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  if (options.githubToken) {
    headers.Authorization = `Bearer ${options.githubToken}`;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(repoInfo.owner)}/${encodeURIComponent(repoInfo.repo)}/readme`,
      { headers }
    );
    const body = await response.text();
    const payload = body ? JSON.parse(body) : null;

    if (!response.ok) {
      return {
        ...repoInfo,
        status: response.status === 404 ? "not_found" : "error",
        content: null,
        content_chars: 0,
        content_truncated: false,
        fetched_at: now,
        last_requested_at: now,
        error_message: payload?.message || response.statusText || "GitHub request failed",
        error_status: response.status,
        updated_at: now,
      };
    }

    let content = "";
    if (payload?.encoding === "base64" && payload?.content) {
      content = Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
    } else if (payload?.download_url) {
      const rawHeaders = {
        "User-Agent": "indexbook-readme-fetcher",
      };
      if (options.githubToken) {
        rawHeaders.Authorization = `Bearer ${options.githubToken}`;
      }
      content = await fetchText(payload.download_url, rawHeaders);
    } else {
      throw new Error(`Unsupported README encoding: ${payload?.encoding || "unknown"}`);
    }

    const truncated = truncateContent(content, options.maxChars);

    return {
      ...repoInfo,
      status: "ok",
      readme_name: payload?.name || "README.md",
      readme_path: payload?.path || null,
      readme_sha: payload?.sha || null,
      readme_html_url: payload?.html_url || null,
      readme_download_url: payload?.download_url || null,
      content: truncated.content,
      content_chars: truncated.content.length,
      content_truncated: truncated.content_truncated,
      size_bytes: Number(payload?.size || Buffer.byteLength(content, "utf8")),
      fetched_at: now,
      last_requested_at: now,
      error_message: null,
      error_status: null,
      updated_at: now,
    };
  } catch (error) {
    return {
      ...repoInfo,
      status: "error",
      content: null,
      content_chars: 0,
      content_truncated: false,
      fetched_at: now,
      last_requested_at: now,
      error_message: error?.message || String(error),
      error_status: null,
      updated_at: now,
    };
  }
}

export function mapGithubReadmeRow(row, options = {}) {
  if (!row) return null;

  const content = typeof row.content === "string" ? row.content : "";
  const mapped = {
    repo_slug: row.repo_slug,
    owner: row.owner,
    repo: row.repo,
    repo_url: row.repo_url,
    status: row.status,
    readme_name: row.readme_name,
    readme_path: row.readme_path,
    readme_html_url: row.readme_html_url,
    readme_download_url: row.readme_download_url,
    content_chars: Number(row.content_chars || content.length || 0),
    content_truncated: Boolean(row.content_truncated),
    size_bytes: row.size_bytes,
    fetched_at: row.fetched_at,
    last_requested_at: row.last_requested_at,
    error_message: row.error_message,
    error_status: row.error_status,
    updated_at: row.updated_at,
  };

  if (options.includeContent) {
    mapped.content = content;
  } else if (content) {
    mapped.content_preview = content.slice(0, 500);
  }

  return mapped;
}
