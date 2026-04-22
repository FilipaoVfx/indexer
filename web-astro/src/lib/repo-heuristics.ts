/**
 * repo-heuristics.ts — client-side heuristic analysis for repo mentions.
 *
 * Given a GitHub repo slug ("owner/repo") and the local corpus, this module
 * finds every bookmark that mentions the repo and labels each mention along
 * three heuristic axes:
 *
 *  - intent:   what the author seemed to be doing with the repo
 *              (build / learn / compare / recommend / ship / critique / discover)
 *  - sentiment: rough positive / neutral / critical read of the tweet
 *  - keywords: top content tokens (ES + EN stopwords removed)
 *
 * Heuristics are dictionary-based and fully local — the goal is to visualize
 * "how did each author approach this repo" without any external LLM call.
 * False positives are tolerated; neutral/discover is the safe fallback.
 */
import { collectItemUrls, extractGithubRepos, type SearchItem } from "./api";

/* ------------------------------------------------------------------ */
/* Author ↔ repo index                                                  */
/* ------------------------------------------------------------------ */

export interface AuthorRepoRef {
  slug: string;
  count: number;
  latest_date: string | null;
}

export interface AuthorRepoEntry {
  /** Stable lookup key (handle when present, otherwise display name). */
  key: string;
  name: string;
  handle: string | null;
  /** slug → { slug, count, latest_date } */
  repos: Map<string, AuthorRepoRef>;
  /** Sum of per-repo counts (total mentions, >= repos.size). */
  totalMentions: number;
}

/**
 * Build a Map<authorKey, AuthorRepoEntry> scanning each item's GitHub repo
 * references. One item can contribute multiple repos. Authors that never
 * mentioned a GitHub repo are excluded so the leaderboard is concise.
 */
export function indexAuthorRepos(items: SearchItem[]): Map<string, AuthorRepoEntry> {
  const out = new Map<string, AuthorRepoEntry>();

  for (const item of items) {
    const handle = item.author_username || null;
    const name = item.author_name || handle || "anonymous";
    const key = handle || name;

    const repos = extractGithubRepos([item]);
    if (repos.size === 0) continue;

    let entry = out.get(key);
    if (!entry) {
      entry = {
        key,
        name,
        handle,
        repos: new Map<string, AuthorRepoRef>(),
        totalMentions: 0,
      };
      out.set(key, entry);
    }

    for (const r of repos.values()) {
      const slug = `${r.owner}/${r.repo}`;
      const prev = entry.repos.get(slug);
      if (prev) {
        prev.count += 1;
        if (
          item.created_at &&
          (!prev.latest_date ||
            new Date(item.created_at) > new Date(prev.latest_date))
        ) {
          prev.latest_date = item.created_at;
        }
      } else {
        entry.repos.set(slug, {
          slug,
          count: 1,
          latest_date: item.created_at || null,
        });
      }
      entry.totalMentions += 1;
    }
  }

  return out;
}

/**
 * Top-N authors by unique repos contributed (desc), tie-breaker = total
 * mentions desc, then name asc.
 */
export function topAuthorsByRepos(
  index: Map<string, AuthorRepoEntry>,
  limit = 10
): AuthorRepoEntry[] {
  return [...index.values()]
    .sort((a, b) => {
      const bySize = b.repos.size - a.repos.size;
      if (bySize !== 0) return bySize;
      const byMentions = b.totalMentions - a.totalMentions;
      if (byMentions !== 0) return byMentions;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

export type MentionIntent =
  | "build"
  | "learn"
  | "compare"
  | "recommend"
  | "ship"
  | "critique"
  | "discover";

export type MentionSentiment = "positive" | "neutral" | "critical";

export interface RepoMention {
  item: SearchItem;
  intent: MentionIntent;
  sentiment: MentionSentiment;
  keywords: string[];
  snippet: string;
  matchedText: string;
}

const STOPWORDS = new Set<string>([
  // Spanish
  "a", "al", "algo", "algun", "alguna", "algunas", "alguno", "algunos",
  "ante", "antes", "aqui", "asi", "aun", "bien", "cada", "como", "con",
  "contra", "cosa", "cual", "cuales", "cualquier", "cuando", "cuanto",
  "de", "del", "desde", "donde", "dos", "el", "ella", "ellas", "ellos",
  "en", "entre", "era", "eran", "eres", "es", "esa", "esas", "ese",
  "eso", "esos", "esta", "estan", "estar", "estas", "este", "esto",
  "estos", "estoy", "fue", "fueron", "fui", "ha", "han", "hasta", "hay",
  "he", "hemos", "ir", "la", "las", "le", "les", "lo", "los", "mas",
  "me", "mi", "mis", "mucho", "muchos", "muy", "nada", "nadie", "ni",
  "no", "nos", "nosotros", "nuestra", "nuestras", "nuestro", "nuestros",
  "o", "os", "otra", "otras", "otro", "otros", "para", "pero", "poco",
  "por", "porque", "pues", "que", "quien", "quienes", "se", "sea",
  "ser", "si", "sido", "siempre", "sin", "sobre", "solo", "son", "soy",
  "su", "sus", "tambien", "tan", "tanto", "te", "tiene", "tienen", "todo",
  "todos", "tras", "tu", "tus", "un", "una", "unas", "uno", "unos",
  "y", "ya", "yo",
  // English
  "a", "about", "above", "after", "again", "against", "all", "am", "an",
  "and", "any", "are", "as", "at", "be", "because", "been", "before",
  "being", "below", "between", "both", "but", "by", "could", "did", "do",
  "does", "doing", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here", "hers",
  "herself", "him", "himself", "his", "how", "i", "if", "in", "into",
  "is", "it", "its", "itself", "just", "me", "more", "most", "my",
  "myself", "no", "nor", "not", "now", "of", "off", "on", "once", "only",
  "or", "other", "our", "ours", "ourselves", "out", "over", "own", "same",
  "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "theirs", "them", "themselves", "then", "there", "these", "they", "this",
  "those", "through", "to", "too", "under", "until", "up", "very", "was",
  "we", "were", "what", "when", "where", "which", "while", "who", "whom",
  "why", "will", "with", "would", "you", "your", "yours", "yourself",
  // Fillers specific to this corpus
  "https", "http", "com", "org", "www", "co", "rt", "via", "tweet",
  "thread", "repo", "github", "via", "etc",
]);

// Intent dictionaries. Tokens are matched against a lowercased, whitespace-
// split version of the tweet text (diacritics preserved → Spanish works).
// Order = priority when multiple intents score equal (first wins).
const INTENT_KEYWORDS: Array<[MentionIntent, string[]]> = [
  ["ship", [
    "shipped", "shipping", "released", "release", "launch", "launched",
    "lanzamos", "lance", "deploy", "deployed", "anuncio", "announce",
    "announced", "production", "produccion", "v1", "v2", "v3", "stable",
    "ga",
  ]],
  ["build", [
    "build", "building", "built", "construi", "construyendo", "construi",
    "hice", "hecho", "made", "making", "armando", "montando", "crafted",
    "coded", "coding", "programando", "implemente", "implementando",
    "side-project", "project", "proyecto", "wip",
  ]],
  ["learn", [
    "learn", "learning", "aprender", "aprendiendo", "aprendi", "estudiar",
    "estudiando", "tutorial", "guia", "guide", "curso", "course", "leer",
    "reading", "lei", "read", "understand", "entender", "entendi", "notes",
    "notas", "bookmark", "marcador", "ref", "referencia",
  ]],
  ["compare", [
    "vs", "versus", "alternative", "alternativa", "instead", "mejor",
    "better", "worse", "peor", "compare", "comparacion", "comparison",
    "diferencia", "difference", "benchmark", "prefiero", "prefer",
  ]],
  ["recommend", [
    "recomiendo", "recommended", "recommend", "recomendable", "must-try",
    "must", "check", "checalo", "prueba", "try", "try-it", "useful", "util",
    "favorite", "favorito", "love", "amo", "me-encanta", "gem", "joya",
    "imprescindible", "tip", "pro-tip",
  ]],
  ["critique", [
    "problema", "problem", "bug", "broken", "roto", "deprecated",
    "obsoleto", "warning", "cuidado", "avoid", "evitar", "nope", "nah",
    "meh", "overrated", "sobrevalorado", "slow", "lento", "crashes",
    "unfortunately", "lamentablemente", "issue",
  ]],
  ["discover", [
    "found", "encontre", "discovered", "descubri", "came-across", "today",
    "hoy", "just", "acabo", "nuevo", "new", "interesante", "interesting",
    "cool", "curioso", "mira", "look", "check-this",
  ]],
];

const POSITIVE_HINTS = [
  "great", "excelente", "genial", "amazing", "awesome", "love", "amo",
  "increible", "brillante", "brilliant", "useful", "util", "powerful",
  "potente", "elegant", "elegante", "clean", "limpio", "simple", "clever",
  "nice", "cool", "solid", "perfect", "perfecto", "best", "mejor",
  "recomiendo", "recommended", "must", "favorite", "favorito", "gem",
  "joya", "fantastico", "fantastic", "wow", "encanta", "fire",
];

const NEGATIVE_HINTS = [
  "bad", "malo", "mala", "pesimo", "terrible", "awful", "broken", "roto",
  "bug", "bugged", "slow", "lento", "painful", "doloroso", "confusing",
  "confuso", "deprecated", "obsoleto", "hate", "odio", "nope", "nah",
  "meh", "overrated", "sobrevalorado", "problematic", "problema", "issue",
  "fails", "fallo", "crash", "crashes",
];

// Emoji: positive and critical sets. Exact-string check (emoji tokens are
// tricky — substring is fine for the heuristic).
const POSITIVE_EMOJI = ["🔥", "🚀", "💯", "✨", "🎉", "👏", "😍", "🙌", "💖", "⭐"];
const NEGATIVE_EMOJI = ["💩", "👎", "😡", "🤮", "⚠️", "🚨"];

function tokenize(text: string): string[] {
  if (!text) return [];
  // Keep letters (incl. accents), digits, hyphens. Drop punctuation/urls/mentions.
  const cleaned = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/@[A-Za-z0-9_]+/g, " ")
    .replace(/#[A-Za-z0-9_]+/g, (m) => ` ${m.slice(1)} `)
    .toLowerCase();

  const tokens: string[] = [];
  for (const raw of cleaned.split(/[^a-z0-9áéíóúñü\-]+/i)) {
    const t = raw.trim().replace(/^[-]+|[-]+$/g, "");
    if (!t) continue;
    if (t.length < 2) continue;
    if (/^\d+$/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

function scoreIntent(tokens: string[], raw: string): MentionIntent {
  const tokenSet = new Set(tokens);
  const lowerRaw = raw.toLowerCase();
  const scores = new Map<MentionIntent, number>();

  for (const [intent, keywords] of INTENT_KEYWORDS) {
    let score = 0;
    for (const kw of keywords) {
      if (kw.includes("-")) {
        if (lowerRaw.includes(kw.replace("-", " "))) score += 1;
      } else if (tokenSet.has(kw)) {
        score += 1;
      }
    }
    if (score > 0) scores.set(intent, score);
  }

  if (scores.size === 0) return "discover";

  let best: MentionIntent = "discover";
  let bestScore = 0;
  for (const [intent] of INTENT_KEYWORDS) {
    const s = scores.get(intent) || 0;
    if (s > bestScore) {
      bestScore = s;
      best = intent;
    }
  }
  return best;
}

function scoreSentiment(tokens: string[], raw: string): MentionSentiment {
  const tokenSet = new Set(tokens);
  let pos = 0;
  let neg = 0;

  for (const kw of POSITIVE_HINTS) {
    if (tokenSet.has(kw)) pos += 1;
  }
  for (const kw of NEGATIVE_HINTS) {
    if (tokenSet.has(kw)) neg += 1;
  }

  for (const emoji of POSITIVE_EMOJI) {
    if (raw.includes(emoji)) pos += 1;
  }
  for (const emoji of NEGATIVE_EMOJI) {
    if (raw.includes(emoji)) neg += 1;
  }

  if (pos >= neg + 2 || (pos >= 2 && neg === 0)) return "positive";
  if (neg >= pos + 1 && neg >= 1) return "critical";
  if (pos >= 1 && neg === 0) return "positive";
  return "neutral";
}

function topKeywords(tokens: string[], slugTokens: Set<string>, max = 5): string[] {
  const counts = new Map<string, number>();
  for (const t of tokens) {
    if (slugTokens.has(t)) continue;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([token]) => token);
}

function makeSnippet(text: string, slug: string, max = 220): string {
  if (!text) return "";
  const [owner, repo] = slug.split("/");
  const lowerText = text.toLowerCase();
  const needle = repo?.toLowerCase() || owner?.toLowerCase() || "";

  if (needle) {
    const idx = lowerText.indexOf(needle);
    if (idx >= 0) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + needle.length + 160);
      let clip = text.slice(start, end).trim();
      if (start > 0) clip = "... " + clip;
      if (end < text.length) clip = clip + " ...";
      return clip.length > max ? clip.slice(0, max - 1) + "…" : clip;
    }
  }

  const plain = text.trim();
  return plain.length > max ? plain.slice(0, max - 1) + "…" : plain;
}

/**
 * Does `item` reference the given `slug` (owner/repo) in URLs, repo_slugs,
 * text or summary? Uses the same extraction logic as extractGithubRepos.
 */
export function itemMentionsRepo(item: SearchItem, slug: string): boolean {
  const normalizedSlug = slug.toLowerCase();
  const repos = extractGithubRepos([item]);
  for (const entity of repos.values()) {
    if (`${entity.owner}/${entity.repo}`.toLowerCase() === normalizedSlug) {
      return true;
    }
  }
  // Fallback: explicit slug in repo_slugs (already picked up above, but
  // belt-and-suspenders if extraction logic changes).
  if (Array.isArray(item.repo_slugs)) {
    for (const s of item.repo_slugs) {
      if (String(s || "").toLowerCase() === normalizedSlug) return true;
    }
  }
  return false;
}

export function findBookmarksForRepo(
  items: SearchItem[],
  slug: string
): SearchItem[] {
  const out: SearchItem[] = [];
  for (const item of items) {
    if (itemMentionsRepo(item, slug)) out.push(item);
  }
  return out;
}

export function analyzeRepoMention(item: SearchItem, slug: string): RepoMention {
  const textParts = [
    item.highlight || "",
    item.text_content || "",
    item.summary || "",
  ].filter(Boolean);
  const matchedText = textParts.join("\n").trim();

  const tokens = tokenize(matchedText);
  const [owner, repo] = slug.toLowerCase().split("/");
  const slugTokens = new Set<string>([owner, repo].filter(Boolean));

  const intent = scoreIntent(tokens, matchedText);
  const sentiment = scoreSentiment(tokens, matchedText);
  const keywords = topKeywords(tokens, slugTokens, 5);
  const snippet = makeSnippet(matchedText || collectItemUrls(item)[0] || "", slug);

  return { item, intent, sentiment, keywords, snippet, matchedText };
}

export function analyzeRepoMentions(
  items: SearchItem[],
  slug: string
): RepoMention[] {
  return findBookmarksForRepo(items, slug).map((item) =>
    analyzeRepoMention(item, slug)
  );
}

export const INTENT_LABELS: Record<MentionIntent, string> = {
  build: "building",
  learn: "learning",
  compare: "comparing",
  recommend: "recommending",
  ship: "shipping",
  critique: "critiquing",
  discover: "discovering",
};

export const SENTIMENT_LABELS: Record<MentionSentiment, string> = {
  positive: "positive",
  neutral: "neutral",
  critical: "critical",
};
