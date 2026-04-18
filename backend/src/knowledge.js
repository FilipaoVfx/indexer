import { parseSearchQuery } from "./search-query.js";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "con", "de",
  "del", "do", "el", "en", "for", "from", "how", "i", "in", "into", "is",
  "it", "la", "las", "los", "me", "mi", "my", "of", "on", "or", "para",
  "por", "que", "quiero", "the", "to", "tu", "un", "una", "y", "your",
]);

const GH_NON_USERS = new Set([
  "about", "collections", "contact", "customer-stories", "enterprise",
  "explore", "features", "followers", "following", "issues", "login",
  "marketplace", "new", "notifications", "orgs", "pricing", "pulls",
  "readme", "search", "security", "settings", "signup", "site",
  "site-map", "sponsors", "stars", "topics", "trending", "watching",
]);

const GH_REGEX =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99}?)(?=[/?#]|\s|$|\.git\b)/gi;

const INTENT_PATTERNS = [
  { intent: "build", regex: /\b(build|create|make|ship|launch|prototype)\b/i },
  { intent: "learn", regex: /\b(learn|understand|study|explore)\b/i },
  { intent: "debug", regex: /\b(debug|fix|solve|troubleshoot)\b/i },
  { intent: "compare", regex: /\b(compare|choose|evaluate|vs)\b/i },
  { intent: "integrate", regex: /\b(integrate|connect|sync|plug)\b/i },
];

const COMPONENT_PATTERNS = [
  { key: "agent", regex: /\b(agent|assistant|copilot)\b/i },
  { key: "api", regex: /\b(api|endpoint|rest|graphql|sdk)\b/i },
  { key: "automation", regex: /\b(automation|workflow|pipeline|orchestr)\w*\b/i },
  { key: "database", regex: /\b(database|db|postgres|supabase|sql)\b/i },
  { key: "frontend", regex: /\b(frontend|ui|astro|react|next|web)\b/i },
  { key: "graph", regex: /\b(graph|knowledge graph|relations?)\b/i },
  { key: "llm", regex: /\b(llm|rag|embedding|prompt|gpt|model)\b/i },
  { key: "search", regex: /\b(search|retrieval|ranking|fts|semantic)\b/i },
];

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, minimum), maximum);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s:/.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value, { minLength = 3 } = {}) {
  return normalizeText(value)
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
    .filter(Boolean)
    .filter((token) => token.length >= minLength)
    .filter((token) => !STOP_WORDS.has(token));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function toTimestamp(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getBookmarkDomain(item) {
  return item.source_domain || extractDomain(item.source_url || "");
}

function buildBookmarkText(item) {
  return [
    item.text_content,
    item.author_name,
    item.author_username,
    item.source_url,
    ...(Array.isArray(item.links) ? item.links : []),
  ]
    .filter(Boolean)
    .join(" \n ");
}

function extractGithubRepos(item) {
  const haystack = buildBookmarkText(item);
  const repos = new Map();
  GH_REGEX.lastIndex = 0;
  let match;

  while ((match = GH_REGEX.exec(haystack)) !== null) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, "");
    if (!repo || GH_NON_USERS.has(owner.toLowerCase())) continue;
    repos.set(`${owner}/${repo}`, { owner, repo });
  }

  return [...repos.values()];
}

function inferAssetType(item) {
  const text = buildBookmarkText(item).toLowerCase();
  const repos = extractGithubRepos(item);

  if (repos.length > 0) return "repo";
  if (/\b(tutorial|guide|step by step|how to)\b/i.test(text)) return "tutorial";
  if (/\b(tool|framework|library|sdk|mcp|cli)\b/i.test(text)) return "tool";
  if ((item.media || []).length > 0 && /\b(video|demo|watch)\b/i.test(text)) return "video";
  if (/\b(paper|research|arxiv)\b/i.test(text)) return "paper";
  return "thread";
}

function inferDifficulty(item) {
  const text = buildBookmarkText(item).toLowerCase();
  if (/\b(beginner|basic|intro|101)\b/i.test(text)) return "basic";
  if (/\b(advanced|deep dive|production|optimiz)\w*\b/i.test(text)) {
    return "advanced";
  }
  return "intermediate";
}

function summarizeText(value, maxLength = 220) {
  const clean = normalizeText(value);
  if (!clean) return "";
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).trimEnd()}...`;
}

function pickTopTerms(items, limit = 8) {
  const counts = new Map();

  for (const item of items) {
    for (const token of tokenize(buildBookmarkText(item))) {
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

function detectIntent(goal) {
  for (const candidate of INTENT_PATTERNS) {
    if (candidate.regex.test(goal)) {
      return candidate.intent;
    }
  }

  return "explore";
}

function inferRequiredComponents(goal) {
  return COMPONENT_PATTERNS
    .filter((entry) => entry.regex.test(goal))
    .map((entry) => entry.key);
}

function scoreBookmarkAgainstQuery(item, parsed) {
  const text = buildBookmarkText(item).toLowerCase();
  const terms = unique(parsed.terms || []);
  const phrases = unique(parsed.phrases || []);
  const exclude = unique(parsed.exclude || []);
  const repos = extractGithubRepos(item);
  const domain = getBookmarkDomain(item);

  let score = 0;
  const reasons = [];
  const matchedTerms = [];

  for (const term of terms) {
    if (text.includes(term.toLowerCase())) {
      score += 2;
      matchedTerms.push(term);
    }
  }

  for (const phrase of phrases) {
    if (text.includes(phrase.toLowerCase())) {
      score += 3;
      reasons.push(`phrase:${phrase}`);
    }
  }

  for (const term of exclude) {
    if (text.includes(term.toLowerCase())) {
      score -= 3;
    }
  }

  if (parsed.filters.author) {
    const authorValue = parsed.filters.author.toLowerCase();
    if (
      (item.author_username || "").toLowerCase().includes(authorValue) ||
      (item.author_name || "").toLowerCase().includes(authorValue)
    ) {
      score += 2;
      reasons.push(`author:${parsed.filters.author}`);
    }
  }

  if (parsed.filters.domain && domain === parsed.filters.domain.toLowerCase()) {
    score += 2;
    reasons.push(`domain:${domain}`);
  }

  if (repos.length > 0) {
    score += Math.min(repos.length, 2);
    reasons.push("github");
  }

  if ((item.links || []).length > 0) {
    score += 0.5;
  }

  if ((item.media || []).length > 0) {
    score += 0.25;
  }

  const createdAt = toTimestamp(item.created_at);
  if (createdAt > 0) {
    const ageDays = (Date.now() - createdAt) / 86_400_000;
    if (ageDays <= 30) score += 0.75;
    else if (ageDays <= 90) score += 0.25;
  }

  return {
    score,
    matched_terms: unique(matchedTerms),
    reasons: unique(reasons),
  };
}

function toKnowledgeItem(item, match) {
  return {
    ...item,
    asset_type: inferAssetType(item),
    difficulty: inferDifficulty(item),
    summary: summarizeText(item.text_content || item.highlight || ""),
    source_domain: getBookmarkDomain(item),
    github_repos: extractGithubRepos(item),
    why_this_result: match.reasons,
    matched_terms: match.matched_terms,
    score: Number(match.score.toFixed(3)),
  };
}

function sortScoredItems(items) {
  return [...items].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return toTimestamp(b.created_at) - toTimestamp(a.created_at);
  });
}

export function buildSemanticSearchResponse({
  query,
  items,
  limit = 20,
  filters = {},
}) {
  const parsed = parseSearchQuery({
    q: query,
    author: filters.author,
    domain: filters.domain,
    from: filters.from,
    to: filters.to,
  });

  const ranked = sortScoredItems(
    items
      .map((item) => {
        const match = scoreBookmarkAgainstQuery(item, parsed);
        return toKnowledgeItem(item, match);
      })
      .filter((item) => item.score > 0)
  ).slice(0, clampNumber(limit, 20, 1, 100));

  return {
    ok: true,
    query,
    total: ranked.length,
    items: ranked,
    parsed_query: parsed,
    strategy: "semantic_lite_v1",
    warning:
      "Embeddings are not enabled yet. Results use lexical overlap plus heuristic relevance.",
  };
}

export function buildGoalSearchResponse({
  goal,
  items,
  limit = 20,
  filters = {},
}) {
  const parsed = parseSearchQuery({
    q: goal,
    author: filters.author,
    domain: filters.domain,
    from: filters.from,
    to: filters.to,
  });

  const intent = detectIntent(goal);
  const requiredComponents = inferRequiredComponents(goal);
  const ranked = sortScoredItems(
    items
      .map((item) => {
        const match = scoreBookmarkAgainstQuery(item, parsed);
        const enriched = toKnowledgeItem(item, match);

        if (intent === "build" && ["repo", "tool", "tutorial"].includes(enriched.asset_type)) {
          enriched.score += 1.25;
          enriched.why_this_result = unique([
            ...enriched.why_this_result,
            `intent:${intent}`,
          ]);
        }

        if (intent === "learn" && ["tutorial", "thread", "paper", "video"].includes(enriched.asset_type)) {
          enriched.score += 1;
          enriched.why_this_result = unique([
            ...enriched.why_this_result,
            `intent:${intent}`,
          ]);
        }

        if (
          requiredComponents.length > 0 &&
          requiredComponents.some((component) =>
            buildBookmarkText(item).toLowerCase().includes(component)
          )
        ) {
          enriched.score += 0.75;
          enriched.why_this_result = unique([
            ...enriched.why_this_result,
            "component-match",
          ]);
        }

        enriched.score = Number(enriched.score.toFixed(3));
        return enriched;
      })
      .filter((item) => item.score > 0)
  ).slice(0, clampNumber(limit, 20, 1, 100));

  const grouped = {
    tools: ranked.filter((item) => item.asset_type === "tool").slice(0, 5),
    tutorials: ranked.filter((item) => item.asset_type === "tutorial").slice(0, 5),
    repos: ranked.filter((item) => item.asset_type === "repo").slice(0, 5),
    examples: ranked.filter((item) => item.asset_type === "thread").slice(0, 5),
  };

  const nextSteps = [];
  if (requiredComponents.includes("search")) {
    nextSteps.push("Validate the retrieval path first: corpus, parsing, and ranking.");
  }
  if (requiredComponents.includes("graph")) {
    nextSteps.push("Model explicit relations early so related-content and route views can reuse them.");
  }
  if (requiredComponents.includes("api")) {
    nextSteps.push("Define stable endpoint contracts before tuning ranking heuristics.");
  }
  if (nextSteps.length === 0) {
    nextSteps.push("Start from the highest-scoring repo or tutorial, then compare adjacent results for implementation tradeoffs.");
  }

  return {
    ok: true,
    goal,
    total: ranked.length,
    items: ranked,
    grouped_results: grouped,
    goal_parse: {
      intent,
      topics: pickTopTerms(ranked, 8).map((entry) => entry.term),
      required_components: requiredComponents,
      parsed_query: parsed,
    },
    next_steps: nextSteps,
    strategy: "goal_heuristic_v1",
    warning:
      "This is a heuristic goal search. Semantic embeddings and graph ranking are not enabled yet.",
  };
}

function countBy(items, getKey, limit) {
  const counts = new Map();

  for (const item of items) {
    const key = getKey(item);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function countRepos(items, limit) {
  const counts = new Map();

  for (const item of items) {
    for (const repo of extractGithubRepos(item)) {
      const key = `${repo.owner}/${repo.repo}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([repo, count]) => ({ repo, count }));
}

export function buildDiscoverResponse({ items, limit = 8 }) {
  const normalizedLimit = clampNumber(limit, 8, 1, 20);
  const recent = [...items]
    .sort((a, b) => toTimestamp(b.created_at) - toTimestamp(a.created_at))
    .slice(0, normalizedLimit)
    .map((item) => ({
      ...item,
      asset_type: inferAssetType(item),
      summary: summarizeText(item.text_content || ""),
      source_domain: getBookmarkDomain(item),
    }));

  return {
    ok: true,
    strategy: "discover_snapshot_v1",
    totals: {
      bookmarks: items.length,
      authors: countBy(items, (item) => item.author_username || item.author_name, 10_000).length,
      domains: countBy(items, (item) => getBookmarkDomain(item), 10_000).length,
      repos: countRepos(items, 10_000).length,
    },
    recent,
    top_authors: countBy(items, (item) => item.author_username || item.author_name, normalizedLimit),
    top_domains: countBy(items, (item) => getBookmarkDomain(item), normalizedLimit),
    top_repos: countRepos(items, normalizedLimit),
    top_topics: pickTopTerms(items, normalizedLimit),
  };
}

export function buildClustersResponse({ items, type = "domain", limit = 10 }) {
  const normalizedLimit = clampNumber(limit, 10, 1, 50);
  const clusters = new Map();

  function ensureCluster(key) {
    if (!clusters.has(key)) {
      clusters.set(key, { key, count: 0, sample_items: [] });
    }
    return clusters.get(key);
  }

  for (const item of items) {
    const keys =
      type === "author"
        ? [item.author_username || item.author_name].filter(Boolean)
        : type === "repo"
        ? extractGithubRepos(item).map((repo) => `${repo.owner}/${repo.repo}`)
        : [getBookmarkDomain(item)].filter(Boolean);

    for (const key of keys) {
      const cluster = ensureCluster(key);
      cluster.count += 1;
      if (cluster.sample_items.length < 3) {
        cluster.sample_items.push({
          id: item.id,
          tweet_id: item.tweet_id,
          author_username: item.author_username,
          author_name: item.author_name,
          summary: summarizeText(item.text_content || ""),
          created_at: item.created_at,
          source_domain: getBookmarkDomain(item),
        });
      }
    }
  }

  return {
    ok: true,
    type,
    strategy: "cluster_heuristic_v1",
    clusters: [...clusters.values()]
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, normalizedLimit),
  };
}

export function buildTrendingResponse({ items, limit = 10 }) {
  const normalizedLimit = clampNumber(limit, 10, 1, 50);
  const recent = [...items]
    .sort((a, b) => toTimestamp(b.created_at) - toTimestamp(a.created_at))
    .slice(0, normalizedLimit);
  const newestTimestamp = toTimestamp(recent[0]?.created_at);
  const horizonMs = 14 * 86_400_000;
  const windowItems = newestTimestamp
    ? items.filter((item) => newestTimestamp - toTimestamp(item.created_at) <= horizonMs)
    : recent;

  return {
    ok: true,
    strategy: "trending_recent_v1",
    window_days: 14,
    items: recent.map((item) => ({
      ...item,
      asset_type: inferAssetType(item),
      summary: summarizeText(item.text_content || ""),
      source_domain: getBookmarkDomain(item),
    })),
    top_authors: countBy(windowItems, (item) => item.author_username || item.author_name, 5),
    top_domains: countBy(windowItems, (item) => getBookmarkDomain(item), 5),
    top_repos: countRepos(windowItems, 5),
  };
}

function scoreRelated(target, candidate) {
  if (!target || !candidate || target.id === candidate.id) {
    return null;
  }

  let score = 0;
  const relationTypes = [];
  const targetTextTokens = new Set(tokenize(buildBookmarkText(target)));
  const candidateTextTokens = new Set(tokenize(buildBookmarkText(candidate)));
  const sharedTerms = [];

  for (const token of targetTextTokens) {
    if (candidateTextTokens.has(token)) {
      sharedTerms.push(token);
    }
  }

  if (
    target.author_username &&
    candidate.author_username &&
    target.author_username === candidate.author_username
  ) {
    score += 4;
    relationTypes.push("same_author");
  }

  const targetDomain = getBookmarkDomain(target);
  const candidateDomain = getBookmarkDomain(candidate);
  if (targetDomain && targetDomain === candidateDomain) {
    score += 2.5;
    relationTypes.push("same_domain");
  }

  const targetRepos = new Set(extractGithubRepos(target).map((repo) => `${repo.owner}/${repo.repo}`));
  const candidateRepos = new Set(extractGithubRepos(candidate).map((repo) => `${repo.owner}/${repo.repo}`));
  const sharedRepos = [...targetRepos].filter((repo) => candidateRepos.has(repo));
  if (sharedRepos.length > 0) {
    score += Math.min(5, sharedRepos.length * 2.5);
    relationTypes.push("shared_repo");
  }

  if (sharedTerms.length > 0) {
    score += Math.min(4, sharedTerms.length * 0.5);
    relationTypes.push("shared_topic");
  }

  const createdDelta = Math.abs(toTimestamp(target.created_at) - toTimestamp(candidate.created_at));
  if (createdDelta <= 14 * 86_400_000) {
    score += 0.75;
  }

  if (score <= 0) {
    return null;
  }

  return {
    score: Number(score.toFixed(3)),
    relation_types: relationTypes,
    shared_terms: sharedTerms.slice(0, 8),
    shared_repos: sharedRepos,
  };
}

export function buildRelatedResponse({ itemId, items, limit = 10 }) {
  const target = items.find((item) => item.id === itemId || item.tweet_id === itemId);
  if (!target) {
    return null;
  }

  const related = items
    .map((candidate) => {
      const relation = scoreRelated(target, candidate);
      if (!relation) return null;
      return {
        ...candidate,
        source_domain: getBookmarkDomain(candidate),
        summary: summarizeText(candidate.text_content || ""),
        relation,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.relation.score - a.relation.score)
    .slice(0, clampNumber(limit, 10, 1, 50));

  return {
    ok: true,
    strategy: "related_heuristic_v1",
    target: {
      ...target,
      source_domain: getBookmarkDomain(target),
      summary: summarizeText(target.text_content || ""),
      github_repos: extractGithubRepos(target),
    },
    items: related,
  };
}

export function buildGraphResponse({ itemId, items, limit = 12 }) {
  const related = buildRelatedResponse({ itemId, items, limit });
  if (!related) return null;

  const nodes = [
    {
      id: related.target.id,
      label: summarizeText(related.target.text_content || related.target.id, 80),
      type: "bookmark",
    },
    ...related.items.map((item) => ({
      id: item.id,
      label: summarizeText(item.text_content || item.id, 80),
      type: "bookmark",
    })),
  ];

  const edges = related.items.map((item) => ({
    source: related.target.id,
    target: item.id,
    weight: item.relation.score,
    relation_types: item.relation.relation_types,
  }));

  return {
    ok: true,
    strategy: "graph_heuristic_v1",
    target: related.target,
    nodes,
    edges,
  };
}
