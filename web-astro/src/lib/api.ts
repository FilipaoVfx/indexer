/**
 * indexbook API client + domain extractors.
 * The UI now supports two remote modes:
 * - hybrid: keyword + structured filters
 * - goal: objective-driven retrieval backed by Supabase knowledge assets
 */

export const API_BASE =
  import.meta.env.PUBLIC_SEARCH_API_BASE ||
  (typeof window !== "undefined" && localStorage.getItem("INDEXBOOK_API")) ||
  "https://indexer-hzto.onrender.com";

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

export interface SearchItem {
  id?: string | number;
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
  score?: number;
  asset_type?: string;
  title?: string;
  summary?: string;
  topics?: string[];
  subtopics?: string[];
  intent_tags?: string[];
  required_components?: string[];
  difficulty?: string;
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
  parsed_query?: ParsedQuery;
}

export interface GoalGroupedResults {
  tools?: SearchItem[];
  tutorials?: SearchItem[];
  repos?: SearchItem[];
  examples?: SearchItem[];
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
  total_bookmarks?: number;
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

export function extractGithubRepos(items: SearchItem[]): Map<string, RepoEntity> {
  const repos = new Map<string, RepoEntity>();

  for (const it of items) {
    const haystack: string[] = [];
    if (it.source_url) haystack.push(it.source_url);
    if (Array.isArray(it.links)) haystack.push(...it.links);
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
  query.set("user_id", "local-user");
  query.set("limit", String(params.limit ?? 100));

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
      user_id: "local-user",
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
  hardLimit = 5000
): Promise<{ items: SearchItem[]; total: number }> {
  const all: SearchItem[] = [];
  const batch = 100;
  let offset = 0;
  let total = Infinity;

  while (all.length < hardLimit && offset < total) {
    const res = await fetch(
      `${API_BASE}/api/bookmarks/search?user_id=local-user&limit=${batch}&offset=${offset}`
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

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`, {
    headers: { Accept: "application/json" },
  });
  const data = (await res.json()) as HealthResponse;
  if (!res.ok) throw new Error("health fetch failed");
  return data;
}

let _corpusPromise: Promise<{ items: SearchItem[]; total: number }> | null = null;

export function getCorpus(force = false) {
  if (force || !_corpusPromise) _corpusPromise = fetchAllBookmarks();
  return _corpusPromise;
}
