/**
 * indexbook API client + domain extractors.
 * The UI now supports two remote modes:
 * - hybrid: keyword + structured filters
 * - goal: objective-driven retrieval backed by Supabase knowledge assets
 */

export const DEFAULT_USER_ID = "";

const DEFAULT_REMOTE_API_BASE = "https://indexer-hzto.onrender.com";

function resolveApiBase(): string {
  const browserOverride =
    typeof window !== "undefined" ? localStorage.getItem("INDEXBOOK_API") : "";
  if (browserOverride) return browserOverride;

  return import.meta.env.PUBLIC_SEARCH_API_BASE || DEFAULT_REMOTE_API_BASE;
}

export const API_BASE = resolveApiBase();

export type SearchMode = "hybrid" | "goal";

export interface ParsedQuery {
  terms?: string[];
  phrases?: string[];
  exclude?: string[];
  filters?: {
    author?: string;
    domain?: string;
    from?: string;
    to?: string;
  };
}

export interface GithubReadme {
  repo_slug: string;
  owner: string;
  repo: string;
  repo_url: string;
  status: "pending" | "ok" | "not_found" | "error";
  readme_name?: string | null;
  readme_path?: string | null;
  readme_html_url?: string | null;
  readme_download_url?: string | null;
  content?: string;
  content_preview?: string;
  content_chars?: number;
  content_truncated?: boolean;
  size_bytes?: number | null;
  fetched_at?: string | null;
  last_requested_at?: string | null;
  error_message?: string | null;
  error_status?: number | null;
  updated_at?: string | null;
  bookmark_count?: number;
  bookmark_ids?: string[];
  user_ids?: string[];
}

export interface ReadmeMatch {
  slug: string;
  url?: string | null;
  preview?: string | null;
  chars?: number;
  score?: number;
}

export interface SearchItem {
  id?: string | number;
  user_id?: string;
  asset_id?: string;
  tweet_id?: string;
  text_content?: string;
  highlight?: string;
  source_url?: string;
  source_domain?: string;
  author_name?: string;
  author_username?: string;
  created_at?: string;
  media?: string[];
  links?: string[];
  first_comment_links?: string[];
  score?: number;
  asset_type?: string;
  title?: string;
  summary?: string;
  topics?: string[];
  subtopics?: string[];
  intent_tags?: string[];
  required_components?: string[];
  difficulty?: string;
  canonical_url?: string;
  repo_slugs?: string[];
  github_readmes?: GithubReadme[];
  readme_match?: ReadmeMatch | null;
  why_this_result?: string[];
  score_breakdown?: Record<string, number | null> | null;
}

export interface HybridSearchResponse {
  mode: "hybrid";
  ok?: boolean;
  items: SearchItem[];
  total: number;
  strategy?: string;
  latency_ms?: number;
  parsed_query?: ParsedQuery;
  warning?: string | null;
}

export interface GoalParse {
  intent?: string;
  topics?: string[];
  required_components?: string[];
  tokens?: string[];
  parsed_query?: ParsedQuery;
}

export interface GoalGroupedResults {
  tools?: SearchItem[];
  tutorials?: SearchItem[];
  repos?: SearchItem[];
  examples?: SearchItem[];
}

export interface GoalStep {
  step: string;
  score: number;
  priority: number;
  contributing_tokens: string[];
}

export interface GoalSearchResponse {
  mode: "goal";
  ok?: boolean;
  goal?: string;
  items: SearchItem[];
  total: number;
  strategy?: string;
  latency_ms?: number;
  goal_parse?: GoalParse;
  grouped_results?: GoalGroupedResults;
  steps?: GoalStep[];
  next_steps?: string[];
  warning?: string | null;
}

export type SearchResponse = HybridSearchResponse | GoalSearchResponse;

export interface AuthorEntity {
  name: string;
  handle: string | null;
  count: number;
  latest_date: string | null;
  domains: Set<string>;
}

export interface RepoEntity {
  owner: string;
  repo: string;
  count: number;
  sample_author: string | null;
  latest_date: string | null;
  urls: Set<string>;
}

export interface HealthResponse {
  ok: boolean;
  user_id?: string | null;
  total_bookmarks?: number;
}

export interface UserSummary {
  user_id: string;
  count: number;
}

const GH_NON_USERS = new Set([
  "orgs", "sponsors", "features", "settings", "notifications", "pulls",
  "issues", "topics", "collections", "marketplace", "explore", "trending",
  "login", "signup", "about", "search", "new", "pricing", "customer-stories",
  "enterprise", "security", "site", "contact", "readme", "site-map",
  "watching", "stars", "following", "followers",
]);

const GH_REGEX =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9._-]{0,119}?)(?=[/?#]|\.git\b|[\s\u2026.,;:!?)\]"'“”]|$)/gi;

function sanitizeGithubRepoSegment(value: string): string {
  return String(value || "")
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+$/g, "");
}

function uniqueUrls(values: string[]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }

  return urls;
}

export function collectItemUrls(item: SearchItem): string[] {
  return uniqueUrls([
    item.canonical_url || "",
    item.source_url || "",
    ...(Array.isArray(item.first_comment_links) ? item.first_comment_links : []),
    ...(Array.isArray(item.links) ? item.links : []),
  ]);
}

export function isGithubRepoUrl(value?: string): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  GH_REGEX.lastIndex = 0;
  return GH_REGEX.test(raw);
}

export function extractGithubRepos(items: SearchItem[]): Map<string, RepoEntity> {
  const repos = new Map<string, RepoEntity>();

  for (const it of items) {
    const haystack: string[] = [];
    haystack.push(...collectItemUrls(it));
    if (Array.isArray(it.repo_slugs)) {
      haystack.push(...it.repo_slugs.map((slug) => `https://github.com/${slug}`));
    }
    if (it.text_content) haystack.push(it.text_content);
    if (it.summary) haystack.push(it.summary);
    const joined = haystack.filter(Boolean).join(" \n ");
    if (!joined) continue;

    GH_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = GH_REGEX.exec(joined)) !== null) {
      const owner = match[1];
      const repo = sanitizeGithubRepoSegment(match[2]);
      if (GH_NON_USERS.has(owner.toLowerCase()) || !repo) continue;

      const key = `${owner}/${repo}`;
      const previous: RepoEntity = repos.get(key) || {
        owner,
        repo,
        count: 0,
        sample_author: null,
        latest_date: null,
        urls: new Set<string>(),
      };

      previous.count += 1;
      previous.sample_author =
        previous.sample_author || it.author_username || it.author_name || null;

      if (
        it.created_at &&
        (!previous.latest_date || new Date(it.created_at) > new Date(previous.latest_date))
      ) {
        previous.latest_date = it.created_at;
      }

      previous.urls.add(`https://github.com/${owner}/${repo}`);
      repos.set(key, previous);
    }
  }

  return repos;
}

export function getPrimaryResourceUrl(item: SearchItem): string {
  const githubRepo = [...extractGithubRepos([item]).values()][0];
  if (githubRepo) {
    return `https://github.com/${githubRepo.owner}/${githubRepo.repo}`;
  }

  return (
    item.canonical_url ||
    item.source_url ||
    collectItemUrls(item)[0] ||
    ""
  );
}

export function getDisplayAssetType(item: SearchItem): string {
  if (item.asset_type === "repo") {
    return "repo";
  }

  return extractGithubRepos([item]).size > 0 ? "repo" : item.asset_type || "";
}

export function extractContextLinks(
  item: SearchItem,
  primaryUrl = ""
): string[] {
  const githubUrls = new Set(
    [...extractGithubRepos([item]).values()].flatMap((repo) =>
      [...repo.urls]
    )
  );

  return collectItemUrls(item).filter((url) => {
    if (!url || url === primaryUrl) {
      return false;
    }

    if (githubUrls.has(url) || isGithubRepoUrl(url)) {
      return false;
    }

    return true;
  });
}

export function extractAllAuthors(items: SearchItem[]): Map<string, AuthorEntity> {
  const map = new Map<string, AuthorEntity>();

  for (const item of items) {
    const handle = item.author_username || null;
    const name = item.author_name || handle || "anonymous";
    const key = handle || name;
    const entry: AuthorEntity = map.get(key) || {
      name,
      handle,
      count: 0,
      latest_date: null,
      domains: new Set<string>(),
    };

    entry.count += 1;
    const domain = item.source_domain || safeDomain(item.source_url || "");
    if (domain) entry.domains.add(domain);

    if (
      item.created_at &&
      (!entry.latest_date || new Date(item.created_at) > new Date(entry.latest_date))
    ) {
      entry.latest_date = item.created_at;
    }

    map.set(key, entry);
  }

  return map;
}

export function extractDomains(items: SearchItem[]): Map<string, number> {
  const domains = new Map<string, number>();

  for (const item of items) {
    const domain = item.source_domain || safeDomain(item.source_url || "");
    if (domain) {
      domains.set(domain, (domains.get(domain) || 0) + 1);
    }
  }

  return domains;
}

export function extractUsers(items: SearchItem[]): UserSummary[] {
  const counts = new Map<string, number>();

  for (const item of items) {
    const userId = String(item.user_id || "").trim();
    if (!userId) continue;
    counts.set(userId, (counts.get(userId) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([user_id, count]) => ({ user_id, count }));
}

export function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function formatDate(value?: string): string {
  if (!value) return "Fecha desconocida";
  const date = new Date(value);
  if (isNaN(date.getTime())) return "Fecha desconocida";
  return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium" }).format(date);
}

export function initials(name: string): string {
  return (
    String(name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((chunk) => chunk[0]?.toUpperCase() || "")
      .join("") || "?"
  );
}

export interface SearchParams {
  user_id?: string;
  q?: string;
  author?: string;
  domain?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  media_only?: boolean;
  links_only?: boolean;
  sort?: "recent" | "relevance";
}

async function parseJsonOrThrow(res: Response) {
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return data;
}

export async function searchHybrid(
  params: SearchParams = {}
): Promise<HybridSearchResponse & { elapsed_ms: number }> {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit ?? 100));

  if (params.user_id) query.set("user_id", params.user_id);
  if (params.offset) query.set("offset", String(params.offset));
  if (params.q) query.set("q", params.q);
  if (params.author) query.set("author", params.author);
  if (params.domain) query.set("domain", params.domain);
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  if (params.sort) query.set("sort", params.sort);

  const startedAt = performance.now();
  const res = await fetch(`${API_BASE}/api/bookmarks/search?${query.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const data = await parseJsonOrThrow(res);
  const elapsed_ms = Math.round(performance.now() - startedAt);

  return {
    ...(data as Omit<HybridSearchResponse, "mode">),
    mode: "hybrid",
    elapsed_ms,
  };
}

export async function searchGoal(
  params: SearchParams = {}
): Promise<GoalSearchResponse & { elapsed_ms: number }> {
  const startedAt = performance.now();
  const res = await fetch(`${API_BASE}/search/goal`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      goal: params.q || "",
      user_id: params.user_id || undefined,
      author: params.author || undefined,
      domain: params.domain || undefined,
      from: params.from || undefined,
      to: params.to || undefined,
      limit: params.limit ?? 30,
      offset: params.offset ?? 0,
    }),
  });
  const data = await parseJsonOrThrow(res);
  const elapsed_ms = Math.round(performance.now() - startedAt);

  return {
    ...(data as Omit<GoalSearchResponse, "mode">),
    mode: "goal",
    elapsed_ms,
  };
}

export async function fetchAllBookmarks(
  hardLimit = Number.POSITIVE_INFINITY,
  userId = DEFAULT_USER_ID
): Promise<{ items: SearchItem[]; total: number }> {
  const all: SearchItem[] = [];
  const batch = 100;
  let offset = 0;
  let total = Infinity;

  while (all.length < hardLimit && offset < total) {
    const query = new URLSearchParams();
    if (userId) query.set("user_id", userId);
    query.set("limit", String(batch));
    query.set("offset", String(offset));
    const res = await fetch(
      `${API_BASE}/api/bookmarks/search?${query.toString()}`
    );
    if (!res.ok) break;
    const data = (await res.json()) as HybridSearchResponse;
    const items = data.items || [];
    if (typeof data.total === "number") total = data.total;
    all.push(...items);
    if (items.length < batch) break;
    offset += batch;
  }

  return { items: all, total: total === Infinity ? all.length : total };
}

export async function fetchHealth(userId = DEFAULT_USER_ID): Promise<HealthResponse> {
  const query = new URLSearchParams();
  if (userId) query.set("user_id", userId);
  const res = await fetch(`${API_BASE}/health${query.toString() ? `?${query.toString()}` : ""}`, {
    headers: { Accept: "application/json" },
  });
  const data = (await res.json()) as HealthResponse;
  if (!res.ok) throw new Error("health fetch failed");
  return data;
}

const corpusCache = new Map<string, Promise<{ items: SearchItem[]; total: number }>>();

export function getCorpus(force = false, userId = DEFAULT_USER_ID) {
  const key = userId || "__all__";
  if (force || !corpusCache.has(key)) {
    corpusCache.set(key, fetchAllBookmarks(Number.POSITIVE_INFINITY, userId));
  }
  return corpusCache.get(key)!;
}

export async function fetchUsers(limit = 100): Promise<UserSummary[]> {
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  const res = await fetch(`${API_BASE}/users?${query.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const data = await parseJsonOrThrow(res);
  return Array.isArray(data?.items) ? data.items : [];
}

export interface GithubReadmesResponse {
  ok?: boolean;
  items: GithubReadme[];
  total: number;
  warning?: string | null;
}

export async function fetchGithubReadmes(params: {
  user_id?: string;
  q?: string;
  repo?: string;
  limit?: number;
  offset?: number;
  include_content?: boolean;
} = {}): Promise<GithubReadmesResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(params.limit ?? 50));
  query.set("offset", String(params.offset ?? 0));
  query.set("include_content", params.include_content === false ? "false" : "true");
  if (params.user_id) query.set("user_id", params.user_id);
  if (params.q) query.set("q", params.q);
  if (params.repo) query.set("repo", params.repo);

  const res = await fetch(`${API_BASE}/api/github-readmes?${query.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const data = await parseJsonOrThrow(res);

  return {
    ok: data.ok,
    items: Array.isArray(data.items) ? data.items : [],
    total: Number(data.total || 0),
    warning: data.warning || null,
  };
}
