/**
 * URL resolver for short-link services.
 *
 * Ingestion pipeline receives many `t.co` (and similar) URLs that hide their
 * real destination. Because downstream consumers (GitHub repo extraction,
 * domain stats, dedupe) key on the final URL, we de-reference shortener
 * hostnames here before persisting the bookmark.
 *
 * Resolution is opportunistic: failures degrade gracefully to the original
 * URL so ingestion never blocks on a slow redirect.
 */

const SHORTENER_HOSTS = new Set([
  "t.co",
  "bit.ly",
  "buff.ly",
  "tinyurl.com",
  "ow.ly",
  "is.gd",
  "goo.gl",
  "lnkd.in",
  "amzn.to",
  "dlvr.it",
  "trib.al",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
  "tiny.cc",
  "rb.gy",
  "s.id"
]);

const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_CACHE_MAX = 2000;

const resolvedCache = new Map();

function cacheGet(key) {
  const entry = resolvedCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    resolvedCache.delete(key);
    return undefined;
  }
  resolvedCache.delete(key);
  resolvedCache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value, ttlMs = DEFAULT_CACHE_TTL_MS) {
  resolvedCache.set(key, {
    value,
    expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0
  });
  if (resolvedCache.size > DEFAULT_CACHE_MAX) {
    const oldest = resolvedCache.keys().next().value;
    if (oldest) resolvedCache.delete(oldest);
  }
}

function parseUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed);
  } catch (_error) {
    return null;
  }
}

export function isShortenerUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  return SHORTENER_HOSTS.has(host);
}

async function followRedirects(startUrl, { timeoutMs, maxRedirects }) {
  let current = startUrl;
  let hops = 0;

  while (hops < maxRedirects) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; indexbook-bot/1.0; +https://indexbook.dev)"
        }
      });
    } catch (error) {
      clearTimeout(timer);
      // Some shorteners reject HEAD -> retry once with GET on the first hop.
      if (hops === 0 && !(error && error.name === "AbortError")) {
        return followWithGet(current, { timeoutMs, maxRedirects });
      }
      throw error;
    }
    clearTimeout(timer);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      try {
        current = new URL(location, current).toString();
      } catch (_error) {
        break;
      }
      hops += 1;
      continue;
    }

    // Non-redirect: we've reached the final URL.
    break;
  }

  return current;
}

async function followWithGet(startUrl, { timeoutMs, maxRedirects }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(startUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; indexbook-bot/1.0; +https://indexbook.dev)"
      }
    });
    return response.url || startUrl;
  } finally {
    clearTimeout(timer);
    void maxRedirects;
  }
}

async function resolveOneUrl(url, options) {
  const cached = cacheGet(url);
  if (cached !== undefined) return cached;

  try {
    const resolved = await followRedirects(url, options);
    cacheSet(url, resolved);
    return resolved;
  } catch (_error) {
    // Cache short negative result to avoid hammering a dead shortlink.
    cacheSet(url, url, 15 * 60 * 1000);
    return url;
  }
}

/**
 * Resolve shortener URLs in place. Returns a Map<originalUrl, resolvedUrl>.
 * Non-shortener URLs are skipped. Unresolvable URLs map back to themselves.
 */
export async function resolveShortenerUrls(urls, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects || DEFAULT_MAX_REDIRECTS;
  const concurrency = options.concurrency || DEFAULT_CONCURRENCY;

  const unique = [];
  const seen = new Set();
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    if (!isShortenerUrl(trimmed)) continue;
    seen.add(trimmed);
    unique.push(trimmed);
  }

  const result = new Map();
  if (unique.length === 0) return result;

  let cursor = 0;
  async function worker() {
    while (cursor < unique.length) {
      const index = cursor;
      cursor += 1;
      const url = unique[index];
      const resolved = await resolveOneUrl(url, { timeoutMs, maxRedirects });
      result.set(url, resolved);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, unique.length) },
    () => worker()
  );
  await Promise.all(workers);
  return result;
}

/**
 * Build a map-and-dedupe helper for an array of URLs. Returns a new array with
 * shortener entries replaced by their resolved form (when available) and
 * duplicates removed while preserving order.
 */
export function rewriteLinksWithResolved(links, resolvedMap) {
  if (!Array.isArray(links)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of links) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const replacement = resolvedMap.get(trimmed) || trimmed;
    if (seen.has(replacement)) continue;
    seen.add(replacement);
    out.push(replacement);
  }
  return out;
}

export const __internal = { SHORTENER_HOSTS, resolvedCache };
