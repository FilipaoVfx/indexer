importScripts("delivery-store.js");
const DEFAULT_API_BASE_URL = "https://indexer-hzto.onrender.com";
const DEFAULT_USER_ID = "local-user";
const QUEUE_STORAGE_KEY = "ingest_queue_v1";
const SCANNER_IDS_CACHE_KEY = "bookmark_scanner_saved_ids_v1";
const SETTINGS_KEYS = ["apiBaseUrl", "userId", "apiKey"];
const ACTIVITY_LOG_MAX = 25;
const LOG_PREFIX = "[x-indexer:bg]";
const URL_RESOLVE_TIMEOUT_MS = 4500;
const MAX_URLS_PER_BOOKMARK = 40;
const SCANNER_IDS_FETCH_TIMEOUT_MS = 25_000;
const DETAIL_LOOKUP_TIMEOUT_MS = 16_000;
const POST_BATCH_TIMEOUT_MS = 25_000;
const DELIVERY_BATCH_SIZE = 10;
const DELIVERY_RUN_LIMIT = 8;
const DETAIL_LOOKUP_MESSAGE_DELAY_MS = 900;
const DETAIL_LOOKUP_MESSAGE_MAX_ATTEMPTS = 8;
const FIRST_COMMENT_LOOKUP_CACHE_MAX = 200;
// Re-lookup diferido de posts densos guardados sin link de GitHub.
const RELOOKUP_STATE_KEY = "fcl_relookup_state_v1";
const RELOOKUP_ALARM_NAME = "fcl-relookup";
const RELOOKUP_ALARM_PERIOD_MINUTES = 360;
const RELOOKUP_MAX_ATTEMPTS = 6;
const RELOOKUP_MIN_RETRY_MS = 6 * 60 * 60 * 1000;
const RELOOKUP_MAX_PER_PASS = 6;
const RELOOKUP_CANDIDATES_LIMIT = 40;
const RELOOKUP_FETCH_TIMEOUT_MS = 30_000;
const RELOOKUP_STATE_MAX = 500;
const SHORTENER_HOST_RE = /^(t\.co|bit\.ly|buff\.ly|ow\.ly|tinyurl\.com|goo\.gl|dlvr\.it|lnkd\.in|is\.gd|tr\.im|cutt\.ly|rebrand\.ly|shorturl\.at)$/i;
const FIRST_COMMENT_CUE_RE = /\b((?:1st|first)\s+(?:comment|reply)|primer\s+comentario|primera\s+respuesta|en\s+comentarios|en\s+las?\s+respuestas|in\s+the\s+comments|in\s+replies|reply\s+below|comments?\s+below)\b/i;
const RESOURCE_HINT_RE = /\b(repo+|repository|github|source|code|codigo|demo|link|links|enlace|enlaces|url|urls|gist|tutorial|readme|doc|docs|article|post|thread|prompt)\b/i;
const DOWNWARD_CUE_RE = /(?:\u{1F447}|\u2B07|\u2193|\bbelow\b|\babajo\b|\baca abajo\b|\baqui abajo\b|\bdown\b)/iu;

const deliveryStore = new IndexerDeliveryStore(chrome.storage.local);
const state = { isFlushing: false, inFlightId: null };
for (const field of ["queue", "failed", "activity", "counters", "jobs", "drafts"]) {
  Object.defineProperty(state, field, { get: () => deliveryStore.data[field] });
}


function logInfo(...args) {
  try { console.info(LOG_PREFIX, ...args); } catch (_e) {}
}
function logWarn(...args) {
  try { console.warn(LOG_PREFIX, ...args); } catch (_e) {}
}
function logError(...args) {
  try { console.error(LOG_PREFIX, ...args); } catch (_e) {}
}

const resolvedUrlCache = new Map();
const firstCommentLookupCache = new Map();
let relookupPassRunning = false;

function safeJsonStringify(value, maxLength = 1200) {
  const seen = new WeakSet();

  try {
    const output = JSON.stringify(
      value,
      (key, nestedValue) => {
        if (typeof nestedValue === "object" && nestedValue !== null) {
          if (seen.has(nestedValue)) {
            return "[Circular]";
          }
          seen.add(nestedValue);
        }

        if (typeof nestedValue === "function") {
          return `[Function ${nestedValue.name || "anonymous"}]`;
        }

        if (nestedValue instanceof Error) {
          return {
            name: nestedValue.name,
            message: nestedValue.message,
            stack: nestedValue.stack || ""
          };
        }

        return nestedValue;
      }
    );

    return output && output.length > maxLength
      ? `${output.slice(0, maxLength)}...`
      : output || "";
  } catch (_error) {
    return "";
  }
}

function extractErrorMessage(error, depth = 0) {
  if (depth > 4 || error == null) {
    return "";
  }

  if (typeof error === "string") {
    return cleanText(error);
  }

  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }

  if (error instanceof Error) {
    const directMessage = cleanText(error.message || "");
    if (directMessage && directMessage !== "[object Object]") {
      return directMessage;
    }

    const causeMessage = extractErrorMessage(error.cause, depth + 1);
    if (causeMessage) {
      return causeMessage;
    }

    const serializedError = safeJsonStringify({
      name: error.name,
      message: error.message,
      stack: error.stack || ""
    });
    return serializedError || error.name || "unknown_error";
  }

  if (Array.isArray(error)) {
    const parts = error
      .map((item) => extractErrorMessage(item, depth + 1))
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join(" | ");
    }
  }

  if (typeof error === "object") {
    const candidateKeys = [
      "message",
      "error",
      "reason",
      "details",
      "detail",
      "description",
      "statusText",
      "cause"
    ];

    for (const key of candidateKeys) {
      const candidateMessage = extractErrorMessage(error[key], depth + 1);
      if (candidateMessage && candidateMessage !== "[object Object]") {
        return candidateMessage;
      }
    }

    const serialized = safeJsonStringify(error);
    if (serialized) {
      return serialized;
    }
  }

  return cleanText(String(error || ""));
}

function formatErrorDetails(error) {
  return {
    message: extractErrorMessage(error) || "unknown_error",
    raw: safeJsonStringify(error)
  };
}

function reportAsyncError(scope, error) {
  logError(scope, formatErrorDetails(error));
}

function buildBookmarkDebugSnapshot(bookmark) {
  if (!bookmark || typeof bookmark !== "object") {
    return {};
  }

  return {
    tweetId: cleanText(bookmark.tweet_id || ""),
    author: cleanText(bookmark.author_username || ""),
    sourceUrl: sanitizeAbsoluteUrl(bookmark.source_url || ""),
    linkCount: Array.isArray(bookmark.links) ? bookmark.links.length : 0,
    firstCommentLinkCount: Array.isArray(bookmark.first_comment_links)
      ? bookmark.first_comment_links.length
      : 0
  };
}

function reportBackgroundStage(stage, details = {}, options = {}) {
  const level = options.level || "info";
  const shouldEmit = options.emit === true;
  const entry = {
    ts: new Date().toISOString(),
    stage,
    ...details
  };

  if (level === "error") {
    logError(stage, entry);
  } else if (level === "warn") {
    logWarn(stage, entry);
  } else {
    logInfo(stage, entry);
  }

  if (shouldEmit) {
    safeSendMessage({
      type: level === "warn" || level === "error" ? "SYNC_ERROR" : "SYNC_PROGRESS",
      payload: {
        stage,
        debug: true,
        ...details
      }
    });
  }

  return entry;
}

if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  self.addEventListener("error", (event) => {
    reportAsyncError("service_worker_error", {
      message: event?.message || "unknown_error",
      filename: event?.filename || "",
      lineno: typeof event?.lineno === "number" ? event.lineno : 0,
      colno: typeof event?.colno === "number" ? event.colno : 0
    });
  });

  self.addEventListener("unhandledrejection", (event) => {
    reportAsyncError("service_worker_unhandled_rejection", event?.reason);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeSendMessage(message) {
  if (["DELIVERY_CONFIRMED", "SETTINGS_CHANGED"].includes(message.type)) {
    void chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }).then(tabs => Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message)))).catch(() => {});
  }
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Ignore popup-not-open errors.
  }
}

async function ensureDefaults() {
  await chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  const current = await chrome.storage.local.get([...SETTINGS_KEYS, QUEUE_STORAGE_KEY]);
  const updates = {};

  if (!current.apiBaseUrl) {
    updates.apiBaseUrl = DEFAULT_API_BASE_URL;
  }

  if (!current.userId) {
    updates.userId = DEFAULT_USER_ID;
  }

  if (!Array.isArray(current[QUEUE_STORAGE_KEY])) {
    updates[QUEUE_STORAGE_KEY] = [];
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function getSettings() {
  await ensureDefaults();
  const current = await chrome.storage.local.get(SETTINGS_KEYS);
  return {
    apiBaseUrl: current.apiBaseUrl || DEFAULT_API_BASE_URL,
    userId: current.userId || DEFAULT_USER_ID,
    apiKey: typeof current.apiKey === "string" ? current.apiKey.trim() : ""
  };
}

// Header x-api-key para los endpoints de escritura del backend (API_KEY en
// Render). Sin key configurada no se manda el header.
function buildWriteHeaders(apiKey, base = {}) {
  const headers = { ...base };
  const key = cleanText(apiKey);
  if (key) {
    headers["x-api-key"] = key;
  }
  return headers;
}

async function loadQueueState() {
  await deliveryStore.load();
  updateBadge();
}

async function changeDelivery(change) {
  const result = await deliveryStore.update(change);
  updateBadge();
  return result;
}

function updateBadge() {
  try {
    const count = state.failed.length || state.queue.length;
    chrome.action.setBadgeBackgroundColor({ color: state.failed.length ? "#dc2626" : state.queue.length ? "#f59e0b" : "#22c55e" });
    chrome.action.setBadgeText({ text: count ? String(count) : "" });
  } catch (_error) {}
}

function addActivity(draft, entry) {
  draft.activity.unshift({ ts: Date.now(), ...entry });
  draft.activity.length = Math.min(draft.activity.length, ACTIVITY_LOG_MAX);
}

async function recordActivity(entry) {
  await changeDelivery(draft => addActivity(draft, entry));
}

function deliveryNamespace(settings) {
  return JSON.stringify([sanitizeBaseUrl(settings.apiBaseUrl), sanitizeUserId(settings.userId)]);
}

function mergeCapture(old, incoming) {
  if (!old) return incoming;
  const richer = incoming.capture === "network" && old.capture !== "network" ||
    (incoming.capture === old.capture && (incoming.text || "").length > (old.text || "").length);
  const merged = { ...(richer ? old : incoming), ...(richer ? incoming : old) };
  for (const field of ["author_handle", "author_username", "author_name", "created_at", "url", "source_url"]) merged[field] = old[field] || incoming[field] || merged[field];
  for (const field of ["links", "first_comment_links", "media"]) merged[field] = uniqueUrls([...(old[field] || []), ...(incoming[field] || [])]);
  return merged;
}

function captureFingerprint(item) {
  return JSON.stringify([item.text || item.text_content || "", item.capture || "dom", item.content_truncated === true,
    item.author_username || item.author_handle || "", item.author_name || "", item.created_at || "",
    item.source_url || item.url || "", item.links || [], item.first_comment_links || [], item.media || []]);
}
function queueCaptureUpgrade(draft, namespace, item, context = {}) {
  if (draft.queue.some(entry => deliveryNamespace(entry) === namespace && entry.bookmarks.some(bookmark => getTweetIdForBookmark(bookmark) === item.tweet_id && captureFingerprint(bookmark) === captureFingerprint(item)))) return;
  const id = `upgrade-${item.tweet_id}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { apiBaseUrl, userId } = context;
  if (deliveryNamespace(context) !== namespace) throw new Error("capture_upgrade_binding_mismatch");
  draft.queue.push({ id, requestId: id, requestIds: [item.tweet_id], kind: "capture_update", source: "capture_upgrade",
    jobId: context.jobId || null, userId, apiBaseUrl, bookmarks: [item], attempts: 0, nextAttemptAt: 0, queuedAt: new Date().toISOString() });
}
async function stageScannerDrafts(items, namespace) {
  const settings = await getSettings();
  const activeNamespace = deliveryNamespace(settings);
  if (namespace && namespace !== activeNamespace) throw new Error("settings_changed_restart_scan");
  await changeDelivery(draft => {
    draft.drafts[activeNamespace] ||= {};
    for (const raw of items || []) {
      const id = getTweetIdForBookmark({ tweet_id: raw?.tweet_id, source_url: raw?.url || raw?.source_url });
      if (!id) throw new Error("invalid_capture_id");
      const receipt = Object.values(draft.receipts).reverse().find(r => r.namespace === activeNamespace && r.ids.includes(id));
      const item = normalizeScannerPendingItemForDelivery(raw, id);
      const merged = mergeCapture(draft.drafts[activeNamespace][id], item);
      if (receipt?.captures?.[id] === captureFingerprint(merged)) continue;
      draft.drafts[activeNamespace][id] = merged;
      const queued = draft.queue.find(entry => deliveryNamespace(entry) === activeNamespace && entry.bookmarks.some(b => getTweetIdForBookmark(b) === id));
      if (queued && queued.id !== state.inFlightId) queued.bookmarks = queued.bookmarks.map(b => getTweetIdForBookmark(b) === id ? mergeCapture(b, merged) : b);
      else if (!queued && receipt) queueCaptureUpgrade(draft, activeNamespace, merged, settings);
    }
  });
  scheduleFlushQueue("capture_checkpoint");
  return { ok: true, namespace: activeNamespace, staged: (items || []).length };
}

function sanitizeBaseUrl(value) {
  if (typeof value !== "string") {
    return DEFAULT_API_BASE_URL;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_API_BASE_URL;
  const parsed = new URL(trimmed);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid_backend_url");
  return trimmed;
}

function sanitizeUserId(value) {
  if (typeof value !== "string") {
    return DEFAULT_USER_ID;
  }
  const trimmed = value.trim().slice(0, 120);
  return trimmed || DEFAULT_USER_ID;
}

function buildBackendUrl(baseUrl, path, params = {}) {
  const endpoint = `${sanitizeBaseUrl(baseUrl)}${path}`;
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    const text = cleanText(String(value ?? ""));
    if (text) {
      url.searchParams.set(key, text);
    }
  }
  return url.toString();
}

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function parseUrlSafe(value) {
  try {
    return new URL(value);
  } catch (_error) {
    return null;
  }
}

function sanitizeAbsoluteUrl(value) {
  const candidate = cleanText(value);
  if (!candidate) {
    return "";
  }
  const parsed = parseUrlSafe(candidate);
  return parsed && /^https?:$/.test(parsed.protocol) ? parsed.toString() : "";
}

function normalizeForLookup(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getBookmarkText(bookmark) {
  if (!bookmark || typeof bookmark !== "object") {
    return "";
  }

  if (typeof bookmark.text === "string") {
    return bookmark.text;
  }

  if (typeof bookmark.text_content === "string") {
    return bookmark.text_content;
  }

  return "";
}

function getTweetIdForBookmark(bookmark) {
  const directTweetId = cleanText(bookmark && bookmark.tweet_id);
  if (/^\d+$/.test(directTweetId)) {
    return directTweetId;
  }

  const sourceUrl = sanitizeAbsoluteUrl(bookmark && bookmark.source_url);
  const match = sourceUrl.match(/\/status\/(\d+)/);
  return match ? match[1] : "";
}

function buildDetailLookupUrl(bookmark) {
  const tweetId = getTweetIdForBookmark(bookmark);
  if (!tweetId) {
    return "";
  }

  const sourceUrl = sanitizeAbsoluteUrl(bookmark && bookmark.source_url);
  const parsed = parseUrlSafe(sourceUrl);

  if (parsed && /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(parsed.hostname)) {
    parsed.protocol = "https:";
    parsed.hostname = "x.com";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  return `https://x.com/i/web/status/${tweetId}`;
}

function trimLookupCache(cache, maxSize) {
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey === "undefined") {
      break;
    }
    cache.delete(oldestKey);
  }
}

function cacheFirstCommentLinks(cacheKey, links) {
  const normalizedLinks = uniqueUrls(links);
  // Solo cachear éxitos: un lookup vacío suele ser timing (tab background aún
  // hidratando, reply recién publicado). Cachear [] envenenaba el tweet para
  // toda la sesión del service worker.
  if (normalizedLinks.length > 0) {
    firstCommentLookupCache.set(cacheKey, normalizedLinks);
    trimLookupCache(firstCommentLookupCache, FIRST_COMMENT_LOOKUP_CACHE_MAX);
  }
  return normalizedLinks.slice();
}

function shouldAttemptFirstCommentLookup(bookmark) {
  if (!bookmark || typeof bookmark !== "object") {
    return false;
  }

  if (uniqueUrls(bookmark.first_comment_links).length > 0) {
    return false;
  }

  if (!getTweetIdForBookmark(bookmark)) {
    return false;
  }

  const normalizedText = normalizeForLookup(getBookmarkText(bookmark));
  if (!normalizedText) {
    return false;
  }

  if (FIRST_COMMENT_CUE_RE.test(normalizedText)) {
    return true;
  }

  return DOWNWARD_CUE_RE.test(normalizedText) && RESOURCE_HINT_RE.test(normalizedText);
}

async function waitForTabComplete(tabId, timeoutMs = DETAIL_LOOKUP_TIMEOUT_MS) {
  const existingTab = await chrome.tabs.get(tabId);
  if (existingTab && existingTab.status === "complete") {
    return existingTab;
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      reject(new Error("detail_tab_timeout"));
    }, timeoutMs);

    function handleUpdated(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve(tab);
    }

    chrome.tabs.onUpdated.addListener(handleUpdated);
  });
}

async function sendDetailLookupMessage(tabId, tweetId) {
  let lastError = null;

  for (let attempt = 1; attempt <= DETAIL_LOOKUP_MESSAGE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: "EXTRACT_FIRST_COMMENT_LINKS",
        payload: { tweetId }
      });

      if (response && response.ok) {
        return {
          links: uniqueUrls(response.links),
          meta: response.meta && typeof response.meta === "object"
            ? response.meta
            : null
        };
      }

      const responseError = cleanText(response && response.error);
      const shouldRetry =
        attempt < DETAIL_LOOKUP_MESSAGE_MAX_ATTEMPTS &&
        (!response ||
          response.retryable === true ||
          responseError === "detail_tweet_not_found" ||
          responseError === "detail_first_comment_links_not_found");

      if (!shouldRetry) {
        return {
          links: [],
          meta: null
        };
      }
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error || "");
      const shouldRetry =
        attempt < DETAIL_LOOKUP_MESSAGE_MAX_ATTEMPTS &&
        /Receiving end does not exist|Could not establish connection|message port closed/i.test(
          message
        );

      if (!shouldRetry) {
        throw error;
      }
    }

    await sleep(DETAIL_LOOKUP_MESSAGE_DELAY_MS);
  }

  if (lastError) {
    throw lastError;
  }

  return {
    links: [],
    meta: null
  };
}

async function closeTabQuietly(tabId) {
  if (typeof tabId !== "number") {
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (_error) {
    // The tab may already be closed.
  }
}

async function extractFirstCommentLinksViaDetailTab(bookmark, context = {}) {
  const tweetId = getTweetIdForBookmark(bookmark);
  const detailUrl = buildDetailLookupUrl(bookmark);
  const traceId = cleanText(context.traceId || "");

  if (!tweetId || !detailUrl) {
    return [];
  }

  const cacheKey = tweetId;
  if (firstCommentLookupCache.has(cacheKey)) {
    return firstCommentLookupCache.get(cacheKey).slice();
  }

  let lookupTabId = null;

  try {
    reportBackgroundStage("bg_first_comment_lookup_started", {
      traceId,
      tweetId,
      detailUrl
    });
    const lookupTab = await chrome.tabs.create({
      url: detailUrl,
      active: false
    });
    lookupTabId = typeof lookupTab?.id === "number" ? lookupTab.id : null;

    if (lookupTabId === null) {
      throw new Error("detail_tab_create_failed");
    }

    await waitForTabComplete(lookupTabId, DETAIL_LOOKUP_TIMEOUT_MS);
    const lookupResult = await sendDetailLookupMessage(lookupTabId, tweetId);
    const links = Array.isArray(lookupResult?.links) ? lookupResult.links : [];
    reportBackgroundStage("bg_first_comment_lookup_completed", {
      traceId,
      tweetId,
      foundLinks: links.length,
      detailMeta: lookupResult?.meta || null
    });
    return cacheFirstCommentLinks(cacheKey, links);
  } catch (error) {
    reportBackgroundStage("bg_first_comment_lookup_failed", {
      traceId,
      tweetId,
      detailUrl,
      error: extractErrorMessage(error) || "unknown_error",
      raw: safeJsonStringify(error, 500)
    }, {
      level: "warn"
    });
    return [];
  } finally {
    await closeTabQuietly(lookupTabId);
  }
}

function isShortenerUrl(value) {
  const parsed = parseUrlSafe(value);
  return Boolean(parsed && SHORTENER_HOST_RE.test(parsed.hostname));
}

function uniqueUrls(values, limit = MAX_URLS_PER_BOOKMARK) {
  const result = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = sanitizeAbsoluteUrl(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) {
      break;
    }
  }

  return result;
}

function withTimeout(promiseFactory, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("request_timeout")); }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => promiseFactory(controller.signal)), deadline])
    .finally(() => clearTimeout(timer));
}

async function fetchJson(url, options, timeoutMs = POST_BATCH_TIMEOUT_MS) {
  return withTimeout(async signal => {
    const response = await fetch(url, { ...options, signal });
    const payload = await response.json().catch(error => { if (response.ok) throw error; return null; });
    if (!response.ok || payload?.ok === false) {
      const error = new Error(payload?.error?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfterMs = Math.max(0, Number(response.headers?.get("retry-after")) || 0) * 1000;
      throw error;
    }
    return payload;
  }, timeoutMs);
}

async function resolveShortUrl(rawUrl) {
  const normalized = sanitizeAbsoluteUrl(rawUrl);
  if (!normalized) {
    return "";
  }

  if (!isShortenerUrl(normalized)) {
    return normalized;
  }

  if (resolvedUrlCache.has(normalized)) {
    return resolvedUrlCache.get(normalized);
  }

  const methods = ["HEAD", "GET"];

  for (const method of methods) {
    try {
      const response = await withTimeout(
        (signal) =>
          fetch(normalized, {
            method,
            redirect: "follow",
            cache: "no-store",
            credentials: "omit",
            signal
          }),
        URL_RESOLVE_TIMEOUT_MS
      );

      const finalUrl = sanitizeAbsoluteUrl(response.url || normalized) || normalized;
      if (method === "GET" && response.body) {
        try {
          await response.body.cancel();
        } catch (_error) {
          // Ignore cancel failures; we already have the final URL.
        }
      }

      resolvedUrlCache.set(normalized, finalUrl);
      return finalUrl;
    } catch (_error) {
      // Try the next method.
    }
  }

  resolvedUrlCache.set(normalized, normalized);
  return normalized;
}

async function resolveUrls(values) {
  const urls = uniqueUrls(values);
  const resolved = await Promise.all(
    urls.map(async (url) => ({
      original: url,
      resolved: await resolveShortUrl(url)
    }))
  );

  return {
    mappings: resolved,
    urls: uniqueUrls(resolved.map((entry) => entry.resolved || entry.original))
  };
}


function normalizeScannerPendingItemForDelivery(item, tweetId) {
  return {
    tweet_id: tweetId || cleanText(item?.tweet_id || ""),
    text: typeof item?.text === "string" ? item.text.slice(0, 12000) : "",
    capture: item?.capture || "dom",
    timeline_order: /^\d+$/.test(String(item?.timeline_order || "")) ? String(item.timeline_order) : "",
    entity_type: item?.entity_type,
    content_truncated: item?.content_truncated === true,
    author_username: cleanText(item?.author_handle || item?.author_username || "").replace(/^@+/, ""),
    author_name: cleanText(item?.author_name || ""),
    // Fecha real del tweet (captura network-first); el backend la normaliza.
    created_at: cleanText(item?.created_at || ""),
    source_url: sanitizeAbsoluteUrl(item?.url || item?.source_url || "") ||
      (tweetId ? `https://x.com/i/web/status/${tweetId}` : ""),
    links: Array.isArray(item?.links) ? item.links : [],
    first_comment_links: Array.isArray(item?.first_comment_links)
      ? item.first_comment_links
      : [],
    media: Array.isArray(item?.media) ? item.media : []
  };
}

async function readScannerIdsCache(settings) {
  const current = await chrome.storage.local.get([SCANNER_IDS_CACHE_KEY]);
  const cached = current[SCANNER_IDS_CACHE_KEY];
  if (!cached || typeof cached !== "object") {
    return null;
  }

  if (
    cached.userId !== settings.userId ||
    cached.apiBaseUrl !== sanitizeBaseUrl(settings.apiBaseUrl) ||
    !Array.isArray(cached.ids)
  ) {
    return null;
  }

  return cached;
}

async function writeScannerIdsCache(settings, payload) {
  const cacheEntry = {
    apiBaseUrl: sanitizeBaseUrl(settings.apiBaseUrl),
    userId: settings.userId,
    version: cleanText(payload.version || ""),
    count: Number(payload.count) || (Array.isArray(payload.ids) ? payload.ids.length : 0),
    ids: Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : [],
    fetchedAt: new Date().toISOString()
  };

  await chrome.storage.local.set({
    [SCANNER_IDS_CACHE_KEY]: cacheEntry
  });

  return cacheEntry;
}

async function fetchBookmarkScannerSavedIdsViaSearch(settings) {
  const ids = [];
  const seen = new Set();
  const limit = 100;
  let offset = 0;
  let total = Infinity;
  let version = "";

  while (offset < total && offset <= 10_000) {
    const endpoint = buildBackendUrl(settings.apiBaseUrl, "/api/bookmarks/search", {
      user_id: settings.userId,
      limit,
      offset
    });
    const payload = await fetchJson(endpoint, { method: "GET", cache: "no-store", headers: { Accept: "application/json" } }, SCANNER_IDS_FETCH_TIMEOUT_MS);
    if (!Array.isArray(payload?.items)) throw new Error("invalid_bookmark_search_response");

    const rows = payload.items;
    total = Number.isFinite(Number(payload.total)) ? Number(payload.total) : total;

    for (const row of rows) {
      const tweetId = cleanText(row?.tweet_id || "");
      if (tweetId && !seen.has(tweetId)) {
        seen.add(tweetId);
        ids.push(tweetId);
      }

      const rowVersion = cleanText(row?.updated_at || row?.inserted_at || "");
      if (rowVersion && (!version || rowVersion > version)) {
        version = rowVersion;
      }
    }

    if (rows.length < limit) {
      break;
    }

    offset += rows.length;
  }

  return {
    ok: true,
    version: version || new Date(0).toISOString(),
    count: ids.length,
    ids,
    fallback: "search",
    truncated: offset > 10_000 && ids.length < total
  };
}

async function fetchBookmarkScannerSavedIds() {
  const settings = await getSettings();
  const namespace = deliveryNamespace(settings);
  const endpoint = buildBackendUrl(settings.apiBaseUrl, "/bookmarks/ids", {
    user_id: settings.userId
  });
  let primaryError = null;

  try {
    const payload = await fetchJson(endpoint, { method: "GET", cache: "no-store", headers: { Accept: "application/json" } }, SCANNER_IDS_FETCH_TIMEOUT_MS);
    if (!payload?.ok || !Array.isArray(payload.ids)) throw new Error("invalid_bookmark_ids_response");

    const cached = await writeScannerIdsCache(settings, payload);
    return {
      ok: true, namespace,
      online: true,
      cached: false,
      version: cached.version,
      count: cached.count,
      ids: cached.ids
    };
  } catch (error) {
    primaryError = error;
  }

  try {
    const fallbackPayload = await fetchBookmarkScannerSavedIdsViaSearch(settings);
    const cached = await writeScannerIdsCache(settings, fallbackPayload);
    return {
      ok: true, namespace,
      online: true,
      cached: false,
      fallback: fallbackPayload.fallback,
      truncated: Boolean(fallbackPayload.truncated),
      version: cached.version,
      count: cached.count,
      ids: cached.ids,
      warning: "bookmark_ids_search_fallback_used",
      primary_error: extractErrorMessage(primaryError)
    };
  } catch (error) {
    const cached = await readScannerIdsCache(settings);
    if (cached) {
      return {
        ok: true, namespace,
        online: false,
        cached: true,
        version: cached.version || "",
        count: Number(cached.count) || cached.ids.length,
        ids: cached.ids,
        error:
          extractErrorMessage(error) ||
          extractErrorMessage(primaryError) ||
          "bookmark_ids_fetch_failed"
      };
    }

    return {
      ok: false, namespace,
      online: false,
      cached: false,
      version: "",
      count: 0,
      ids: [],
      error:
        extractErrorMessage(error) ||
        extractErrorMessage(primaryError) ||
        "bookmark_ids_fetch_failed"
    };
  }
}

async function importBookmarkScannerPending(items, source = "x_bookmarks_dom_scan", jobId = null, namespace = null, requestId = null, requestIds = null) {
  const settings = await getSettings();
  const normalized = (items || []).map(item => normalizeScannerPendingItemForDelivery(item, getTweetIdForBookmark({tweet_id:item.tweet_id, source_url:item.url || item.source_url})));
  const result = await enqueueBatch({ bookmarks: normalized, source, kind: "scanner", jobId, namespace, requestId, requestIds });
  return { ...result, queued: normalized.length, imported_ids: [], duplicate_ids: [] };
}

async function startCaptureJob(tabId, range = {}) {
  const settings = await getSettings();
  const namespace = deliveryNamespace(settings);
  const id = `scan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await changeDelivery(draft => {
    for (const job of Object.values(draft.jobs)) if (job.namespace === namespace && job.phase === "scanning") {
      if (Date.now() - job.updatedAt < 120000) throw new Error("scan_already_running");
      job.phase = "interrupted"; job.error = "scan_heartbeat_expired";
    }
    const completedJobs = Object.values(draft.jobs).filter(job => !["scanning", "delivering"].includes(job.phase));
    if (completedJobs.length > 100) for (const job of completedJobs.sort((a,b) => a.updatedAt - b.updatedAt).slice(0, completedJobs.length - 100)) delete draft.jobs[job.id];
    draft.jobs[id] = { id, namespace, tabId, range, phase: "scanning", scanFinished: false, confirmed: 0, failed: 0, queued: 0, updatedAt: Date.now() };
  });
  void launchCaptureJob(state.jobs[id]);
  return { ok: true, jobId: id, phase: "scanning" };
}

async function launchCaptureJob(job) {
  try {
    const response = await chrome.tabs.sendMessage(job.tabId, { type: "BOOKMARK_SCANNER_RUN_JOB", payload: job });
    if (!response?.ok) throw new Error(response?.error || "scan_not_started");
  } catch (error) {
    await changeDelivery(draft => {
      if (draft.jobs[job.id]?.phase === "scanning") Object.assign(draft.jobs[job.id], { phase: "interrupted", error: extractErrorMessage(error) });
    });
  }
}

// ─── Re-lookup diferido de posts densos sin repo ──────────────────────
// Bookmarks ya guardados con cue ("REPOOO👇") pero sin link de GitHub: el
// reply no existía al capturar o el tab de detalle falló. El backend los
// marca duplicados en imports futuros, así que nadie los reintenta. Este
// pase pide candidatos al backend, re-corre el lookup de detalle y parchea
// la fila vía PATCH (el backend re-dispara el sync de repos/context links).

async function readRelookupState() {
  const current = await chrome.storage.local.get([RELOOKUP_STATE_KEY]);
  const stored = current[RELOOKUP_STATE_KEY];
  return stored && typeof stored === "object" ? stored : {};
}

async function writeRelookupState(relookupState) {
  for (const scope of Object.values(relookupState.scopes || {})) {
    const entries = Object.entries(scope.tweets || {});
    if (entries.length > RELOOKUP_STATE_MAX) {
      entries.sort((a,b) => (Number(b[1]?.lastAt) || 0) - (Number(a[1]?.lastAt) || 0));
      scope.tweets = Object.fromEntries(entries.slice(0, RELOOKUP_STATE_MAX));
    }
  }
  await chrome.storage.local.set({ [RELOOKUP_STATE_KEY]: relookupState });
  return relookupState;
}

async function fetchRelookupCandidates(settings, offset = 0) {
  const payload = await fetchJson(buildBackendUrl(settings.apiBaseUrl, "/api/bookmarks/relookup-candidates", {
    user_id: settings.userId, limit: RELOOKUP_CANDIDATES_LIMIT, offset
  }), { method: "GET", cache: "no-store", headers: { Accept: "application/json" } }, RELOOKUP_FETCH_TIMEOUT_MS);
  if (!Array.isArray(payload?.items)) throw new Error("invalid_relookup_candidates");
  return payload;
}
async function patchFirstCommentLinks(settings, candidate, links) {
  return fetchJson(buildBackendUrl(settings.apiBaseUrl, "/api/bookmarks/first-comment-links"), {
    method: "PATCH", headers: buildWriteHeaders(settings.apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({ user_id: settings.userId, tweet_id: candidate.tweet_id, first_comment_links: links })
  }, RELOOKUP_FETCH_TIMEOUT_MS);
}

async function runFirstCommentRelookupPass(trigger = "manual") {
  if (relookupPassRunning) {
    return { ok: true, skipped: "already_running", trigger };
  }
  relookupPassRunning = true;

  try {
    const settings = await getSettings();
    let allState = await readRelookupState();
    if (allState.version !== 2) allState = { version: 2, scopes: {} };
    allState.scopes ||= {};
    const namespace = deliveryNamespace(settings);
    const relookupState = allState.scopes[namespace] ||= { tweets: {}, offset: 0, pending: [] };
    if (!relookupState.pending.length) {
      const page = await fetchRelookupCandidates(settings, relookupState.offset);
      relookupState.pending = page.items; relookupState.offset = page.next_offset || 0;
      await writeRelookupState(allState);
    }
    const candidates = relookupState.pending;
    const now = Date.now();

    // Backoff por tweet: máx RELOOKUP_MAX_ATTEMPTS intentos, mínimo
    // RELOOKUP_MIN_RETRY_MS entre intentos. Un post cuyo autor nunca publicó
    // el link no puede quedar reintentándose para siempre.
    const eligible = candidates
      .filter((candidate) => {
        const tweetId = getTweetIdForBookmark(candidate);
        if (!tweetId) {
          return false;
        }
        const entry = relookupState.tweets[tweetId];
        if (!entry) {
          return true;
        }
        if (entry.done === true) {
          return false;
        }
        if ((Number(entry.attempts) || 0) >= RELOOKUP_MAX_ATTEMPTS) {
          return false;
        }
        return now - (Number(entry.lastAt) || 0) >= RELOOKUP_MIN_RETRY_MS;
      })
      .slice(0, RELOOKUP_MAX_PER_PASS);

    reportBackgroundStage("bg_fcl_relookup_pass_started", {
      trigger,
      candidates: candidates.length,
      eligible: eligible.length
    }, { emit: true });

    if (eligible.length === 0) {
      relookupState.pending = [];
      await writeRelookupState(allState);
      return { ok: true, trigger, candidates: candidates.length, attempted: 0, recovered: 0, failed: 0 };
    }

    const traceId = `relookup-${Date.now().toString(36)}`;
    let recovered = 0;
    let failed = 0;

    for (const candidate of eligible) {
      const tweetId = getTweetIdForBookmark(candidate);
      const entry = relookupState.tweets[tweetId] || { attempts: 0 };
      entry.attempts = (Number(entry.attempts) || 0) + 1;
      entry.lastAt = Date.now();
      relookupState.tweets[tweetId] = entry;
      await writeRelookupState(allState);

      try {
        const rawLinks = await extractFirstCommentLinksViaDetailTab(candidate, { traceId });
        let links = uniqueUrls(rawLinks);
        if (links.length === 0) {
          continue;
        }

        try {
          const resolved = await resolveUrls(links);
          links = uniqueUrls(resolved.urls);
        } catch (_error) {
          // mejor sin resolver que perder el hallazgo
        }

        const patchResult = await patchFirstCommentLinks(settings, candidate, links);
        entry.done = true;
        recovered += 1;
        reportBackgroundStage("bg_fcl_relookup_recovered", {
          traceId,
          tweetId,
          links: links.length,
          updated: patchResult.updated === true,
          attempts: entry.attempts
        }, { emit: true });
      } catch (error) {
        failed += 1;
        reportBackgroundStage("bg_fcl_relookup_attempt_failed", {
          traceId,
          tweetId,
          attempts: entry.attempts,
          error: extractErrorMessage(error) || "unknown_error"
        }, { level: "warn" });
      }
    }

    relookupState.pending = candidates.filter(c => !eligible.includes(c));
    await writeRelookupState(allState);
    await recordActivity({
      stage: "relookup_densos",
      traceId,
      candidates: candidates.length,
      attempted: eligible.length,
      recovered,
      failed
    });

    return {
      ok: true,
      trigger,
      candidates: candidates.length,
      attempted: eligible.length,
      recovered,
      failed
    };
  } finally {
    relookupPassRunning = false;
  }
}

function scheduleFirstCommentRelookupPass(trigger) {
  void runFirstCommentRelookupPass(trigger).catch((error) => {
    reportAsyncError(`fcl_relookup_failed:${trigger}`, error);
  });
}

async function postBatch(queueItem) {
  const current = await getSettings();
  const settings = { ...current, apiBaseUrl: queueItem.apiBaseUrl, userId: queueItem.userId };
  if (sanitizeBaseUrl(current.apiBaseUrl) !== settings.apiBaseUrl) {
    const error = new Error("queued_destination_changed_restore_settings"); error.status = 401; throw error;
  }
  // Persist and deliver the original capture first. Reply enrichment runs separately.

  return fetchJson(buildBackendUrl(settings.apiBaseUrl, "/api/bookmarks/batch"), {
    method: "POST", headers: buildWriteHeaders(settings.apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({ user_id: settings.userId, sync_id: queueItem.syncId,
      batch_index: queueItem.batchIndex, bookmarks: queueItem.bookmarks })
  });
}

function acknowledgeBatch(item, response) {
  if (!response || response.ok !== true) throw new Error("invalid_delivery_acknowledgement");
  const ids = response.stored_ids || response.imported_ids;
  if (!Array.isArray(ids) && !Array.isArray(response.duplicate_ids)) throw new Error("backend_id_ack_required_update_backend");
  const sent = new Set(item.bookmarks.map(bookmark => getTweetIdForBookmark(bookmark)));
  const accepted = [...new Set([...(ids || []), ...(response.duplicate_ids || [])].map(String))];
  if (accepted.some(id => !sent.has(id))) throw new Error("unexpected_acknowledgement_id");
  return accepted;
}

async function flushQueue() {
  await loadQueueState();
  if (state.isFlushing) return;
  state.isFlushing = true;
  try {
    for (let round = 0; round < DELIVERY_RUN_LIMIT; round++) {
      const item = state.queue.find(entry => (entry.nextAttemptAt || 0) <= Date.now());
      if (!item) break;
      state.inFlightId = item.id;
      let response, accepted;
      try { response = await postBatch(item); accepted = acknowledgeBatch(item, response); }
      catch (error) {
        await changeDelivery(draft => {
          const current = draft.queue.find(entry => entry.id === item.id);
          if (!current) return;
          current.attempts = (current.attempts || 0) + 1;
          current.lastError = extractErrorMessage(error);
          const permanent = [400, 401, 403, 413, 422].includes(error.status);
          if (permanent) {
            draft.queue = draft.queue.filter(entry => entry.id !== item.id);
            draft.failed.push({ ...current, failedAt: new Date().toISOString() });
            draft.counters.failed += current.bookmarks.length;
            if (current.jobId && draft.jobs[current.jobId]) {
              const job = draft.jobs[current.jobId]; job.failed = (job.failed || 0) + current.bookmarks.length;
              if (job.scanFinished) job.phase = "needs_attention";
            }
          } else current.nextAttemptAt = Date.now() + Math.max(error.retryAfterMs || 0,
            Math.min(3600000, 30000 * 2 ** Math.min(current.attempts - 1, 7)));
          addActivity(draft, { stage: permanent ? "rechazado" : "pendiente_reintento", error: current.lastError, queueItemId: item.id });
        });
        safeSendMessage({ type: "SYNC_ERROR", payload: { stage: "bg_delivery_pending", error: extractErrorMessage(error) } });
        continue;
      }
      // Commit after transport handling: a local storage failure is NOT a network retry.
      await changeDelivery(draft => {
        const current = draft.queue.find(entry => entry.id === item.id);
        if (!current) return;
        const confirmed = new Set(accepted);
        const remaining = current.bookmarks.filter(bookmark => !confirmed.has(getTweetIdForBookmark(bookmark)));
        draft.queue = draft.queue.filter(entry => entry.id !== item.id);
        if (remaining.length) {
          draft.failed.push({ ...current, bookmarks: remaining, lastError: "items_not_acknowledged", failedAt: new Date().toISOString(), invalid: response.invalid || [] });
          draft.counters.failed += remaining.length;
        }
        draft.counters.delivered += accepted.length;
        const previousReceipt = draft.receipts[current.requestId];
        draft.receipts[current.requestId] = { captures: { ...(previousReceipt?.captures || {}), ...Object.fromEntries(item.bookmarks.filter(b => confirmed.has(getTweetIdForBookmark(b))).map(b => [getTweetIdForBookmark(b), captureFingerprint(b)])) }, at: Date.now(), namespace: deliveryNamespace(current),
          ids: [...new Set([...(previousReceipt?.ids || []), ...accepted])], requestIds: current.requestIds || current.bookmarks.map(getTweetIdForBookmark),
          complete: !draft.queue.some(entry => entry.requestId === current.requestId) && !draft.failed.some(entry => entry.requestId === current.requestId) };
        const receiptKeys = Object.keys(draft.receipts);
        if (receiptKeys.length > 1000) delete draft.receipts[receiptKeys[0]];

        const namespace = deliveryNamespace(current);
        for (const id of accepted) {
          const staged = draft.drafts[namespace]?.[id];
          const sent = item.bookmarks.find(b => getTweetIdForBookmark(b) === id);
          if (staged && captureFingerprint(staged) !== captureFingerprint(sent)) queueCaptureUpgrade(draft, namespace, staged, current);
          else delete draft.drafts[namespace]?.[id];
        }
        if (current.jobId && draft.jobs[current.jobId]) {
          const job = draft.jobs[current.jobId];
          job.confirmedIds = [...new Set([...(job.confirmedIds || []), ...accepted])];
          job.confirmed = job.confirmedIds.length;
          job.failed = (job.failed || 0) + remaining.length;
          const pending = draft.queue.some(entry => entry.jobId === job.id);
          if (job.scanFinished) job.phase = pending ? "delivering" : job.failed ? "needs_attention" : "confirmed";
        }
        addActivity(draft, { stage: "ingesta_confirmada", queueItemId: item.id, count: accepted.length, rejected: remaining.length });
      });
      safeSendMessage({ type: "DELIVERY_CONFIRMED", payload: { namespace: deliveryNamespace(item), ids: accepted.filter(id => !state.queue.some(entry => deliveryNamespace(entry) === deliveryNamespace(item) && entry.bookmarks.some(b => getTweetIdForBookmark(b) === id))), jobId: item.jobId } });
    }
  } finally { state.isFlushing = false; state.inFlightId = null; }
}

async function retryFailedQueueItems() {
  return changeDelivery(draft => {
    const failed = draft.failed;
    draft.queue.push(...failed.map(({ failedAt, lastError, ...item }) => ({ ...item, attempts: 0, nextAttemptAt: 0 })));
    draft.failed = [];
    for (const item of failed) if (item.jobId && draft.jobs[item.jobId]) { draft.jobs[item.jobId].failed = 0; draft.jobs[item.jobId].phase = "delivering"; }
    return { requeued: failed.length, pendingQueue: draft.queue.length };
  }).then(result => { scheduleFlushQueue("retry_failed"); return result; });
}

function scheduleFlushQueue(reason) {
  void flushQueue().catch(error => {
    reportAsyncError(`flush_queue_failed:${reason}`, error);
    safeSendMessage({ type: "SYNC_ERROR", payload: { stage: "bg_delivery_storage_error", error: extractErrorMessage(error) } });
  });
}

function bootstrapQueue(reason) {
  scheduleFlushQueue(reason);
  void loadQueueState().then(() => {
    for (const job of Object.values(state.jobs)) if (job.phase === "scanning") void launchCaptureJob(job);
  }).catch(error => reportAsyncError("restore_jobs", error));
}

async function enqueueBatch(payload) {
  if (!Array.isArray(payload?.bookmarks) || !payload.bookmarks.length || payload.bookmarks.length > 40) throw new Error("capture_batch_requires_1_to_40_items");
  const settings = await getSettings();
  if (payload.namespace && payload.namespace !== deliveryNamespace(settings)) throw new Error("settings_changed_restart_scan");
  const id = payload.requestId || `${payload.syncId || "sync"}-${payload.batchIndex || 0}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const result = await changeDelivery(draft => {
    if (payload.jobId && draft.jobs[payload.jobId]?.namespace !== deliveryNamespace(settings)) throw new Error("job_namespace_mismatch");
    const requestIds = payload.requestIds || payload.bookmarks.map(getTweetIdForBookmark);
    const previous = draft.receipts[id] || draft.queue.find(item => item.requestId === id) || draft.failed.find(item => item.requestId === id);
    if (previous) {
      if (JSON.stringify(previous.requestIds || previous.ids) !== JSON.stringify(requestIds)) throw new Error("request_id_payload_mismatch");
      return { ok: true, queued: true, pendingQueue: draft.queue.length };
    }
    const unique = new Map();
    for (const bookmark of payload.bookmarks) {
      const tweetId = getTweetIdForBookmark(bookmark);
      if (!tweetId) throw new Error("invalid_capture_id");
      unique.set(tweetId, mergeCapture(unique.get(tweetId), bookmark));
    }
    const namespace = deliveryNamespace(settings);
    const bookmarks = [...unique.values()].map(item => payload.kind === "scanner" ? mergeCapture(item, draft.drafts[namespace]?.[getTweetIdForBookmark(item)] || item) : item);
    for (let start = 0; start < bookmarks.length; start += DELIVERY_BATCH_SIZE) draft.queue.push({
      id: `${id}-${start}`, requestId: id, requestIds, kind: payload.kind || "auto", jobId: payload.jobId || null,
      syncId: payload.syncId || null, batchIndex: Math.floor(start / DELIVERY_BATCH_SIZE),
      traceId: payload.traceId || id, source: payload.source || "auto", bookmarks: bookmarks.slice(start, start + DELIVERY_BATCH_SIZE),
      userId: settings.userId, apiBaseUrl: sanitizeBaseUrl(settings.apiBaseUrl), attempts: 0, nextAttemptAt: 0, queuedAt: new Date().toISOString()
    });
    draft.counters.captured += bookmarks.length;
    if (payload.jobId && draft.jobs[payload.jobId]) Object.assign(draft.jobs[payload.jobId], { queued: (draft.jobs[payload.jobId].queued || 0) + bookmarks.length, updatedAt: Date.now() });
    addActivity(draft, { stage: "lote_encolado", count: bookmarks.length });
    return { ok: true, queued: true, queuedCount: bookmarks.length, pendingQueue: draft.queue.length, queueItemId: id };
  });
  scheduleFlushQueue("enqueue");
  return result;
}

async function updateSettings(payload) {
  const updates = {};
  if (payload && typeof payload === "object") {
    if (typeof payload.apiBaseUrl === "string") {
      updates.apiBaseUrl = sanitizeBaseUrl(payload.apiBaseUrl);
    }
    if (typeof payload.userId === "string") {
      updates.userId = sanitizeUserId(payload.userId);
    }
    if (typeof payload.apiKey === "string") {
      updates.apiKey = payload.apiKey.trim().slice(0, 200);
    }
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  return getSettings();
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureDefaults().catch((error) => {
    reportAsyncError("ensure_defaults_failed:onInstalled", error);
  });
  bootstrapQueue("onInstalled");
});

// MV3: el service worker muere a los ~30s idle; sin un reloj nadie drena la
// cola que quedó pendiente. Alarm cada minuto: si hay cola, flush.
try {
  chrome.alarms.create("queue-drain", { periodInMinutes: 1 });
  // Re-lookup: solo crear si no existe. create() resetea el timer y el
  // service worker reinicia seguido — recreándola en cada arranque la alarma
  // de 6h nunca llegaría a disparar.
  chrome.alarms.get(RELOOKUP_ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(RELOOKUP_ALARM_NAME, {
        periodInMinutes: RELOOKUP_ALARM_PERIOD_MINUTES,
        delayInMinutes: 15
      });
    }
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === RELOOKUP_ALARM_NAME) {
      scheduleFirstCommentRelookupPass("alarm");
      return;
    }
    if (alarm?.name !== "queue-drain") return;
    void (async () => {
      await loadQueueState();
      if (state.queue.length > 0) {
        scheduleFlushQueue("alarm");
      }
    })().catch((error) => reportAsyncError("alarm_drain", error));
  });
} catch (error) {
  reportAsyncError("alarm_setup", error);
}

chrome.tabs.onRemoved?.addListener(tabId => {
  void changeDelivery(draft => {
    for (const job of Object.values(draft.jobs)) if (job.tabId === tabId && job.phase === "scanning") Object.assign(job, { phase: "interrupted", error: "x_tab_closed", coverage: "partial", updatedAt: Date.now() });
  }).catch(error => reportAsyncError("scan_tab_closed", error));
});

chrome.runtime.onStartup.addListener(() => {
  bootstrapQueue("onStartup");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    await loadQueueState();

    if (!message || typeof message.type !== "string") {
      sendResponse({
        ok: false,
        error: "invalid_message"
      });
      return;
    }

    const fromPopup = sender?.url === chrome.runtime.getURL("popup.html");
    if (["SETTINGS_UPDATE", "RETRY_FAILED", "CLEAR_ACTIVITY", "START_BOOKMARK_IMPORT", "RELOOKUP_DENSE"].includes(message.type) && !fromPopup) throw new Error("popup_action_required");
    if (sender?.id && sender.id !== chrome.runtime.id) throw new Error("invalid_message_sender");
    if (message.type === "BOOKMARK_SCANNER_STAGE") {
      if (!Array.isArray(message.payload?.items) || message.payload.items.length > 40) throw new Error("invalid_stage_batch");
      sendResponse(await stageScannerDrafts(message.payload.items, message.payload.namespace)); return;
    }
    if (message.type === "BOOKMARK_SCANNER_CLEAR_DRAFTS") {
      const namespace = deliveryNamespace(await getSettings());
      if (message.payload?.namespace !== namespace) throw new Error("settings_changed_restart_scan");
      await changeDelivery(draft => {
        const queued = new Set([...draft.queue, ...draft.failed].filter(entry => deliveryNamespace(entry) === namespace).flatMap(entry => entry.bookmarks.map(getTweetIdForBookmark)));
        for (const id of message.payload?.ids || []) if (!queued.has(id)) delete draft.drafts[namespace]?.[id];
      });
      sendResponse({ ok: true }); return;
    }
    if (message.type === "BOOKMARK_SCANNER_RESTORE" || message.type === "GET_DELIVERY_STATUS") {
      const namespace = deliveryNamespace(await getSettings());
      const jobs = Object.values(state.jobs).filter(job => job.namespace === namespace).sort((a,b) => b.updatedAt - a.updatedAt);
      const queued = state.queue.filter(item => deliveryNamespace(item) === namespace);
      const failed = state.failed.filter(item => deliveryNamespace(item) === namespace);
      sendResponse({ ok: true, namespace, items: Object.values(state.drafts[namespace] || {}),
        queuedIds: queued.flatMap(item => item.bookmarks.map(getTweetIdForBookmark)),
        confirmedIds: Object.values(deliveryStore.data.receipts).filter(r => r.namespace === namespace).flatMap(r => r.ids),
        pendingCount: queued.reduce((n,item) => n + item.bookmarks.length, 0),
        failedCount: failed.reduce((n,item) => n + item.bookmarks.length, 0), job: jobs[0] || null }); return;
    }
    if (message.type === "START_BOOKMARK_IMPORT") {
      const tab = await chrome.tabs.get(message.payload?.tabId);
      if (!/^https:\/\/(x\.com|twitter\.com)\/i\/bookmarks(?:[/?#]|$)/.test(tab?.url || "")) throw new Error("open_x_bookmarks_first");
      sendResponse(await startCaptureJob(tab.id, message.payload?.range || {})); return;
    }
    if (message.type === "BOOKMARK_SCANNER_SELECT_JOB") {
      const p = message.payload || {};
      const ids = await changeDelivery(draft => {
        const job = draft.jobs[p.jobId];
        if (!job || job.namespace !== p.namespace || sender?.tab?.id !== job.tabId) throw new Error("invalid_scan_job");
        if (job.selectedIds) return job.selectedIds;
        if (!Array.isArray(p.ids) || p.ids.some(id => !draft.drafts[job.namespace]?.[id])) throw new Error("selected_capture_not_durable");
        job.selectedIds = [...new Set(p.ids)]; job.updatedAt = Date.now();
        return job.selectedIds;
      });
      sendResponse({ ok: true, ids }); return;
    }
    if (message.type === "BOOKMARK_SCANNER_JOB_PROGRESS") {
      const p = message.payload || {};
      await changeDelivery(draft => {
        const job = draft.jobs[p.jobId];
        if (!job || job.namespace !== p.namespace || sender?.tab?.id !== job.tabId) throw new Error("invalid_scan_job");
        for (const key of ["coverage", "rounds", "error", "scanFinished"]) if (p[key] !== undefined) job[key] = p[key];
        job.updatedAt = Date.now();
        if (p.error) job.phase = "interrupted";
        else if (job.scanFinished) job.phase = draft.queue.some(item => item.jobId === job.id) ? "delivering" : job.failed ? "needs_attention" : "confirmed";
      });
      sendResponse({ ok: true }); return;
    }
    if (message.type === "INGEST_ENQUEUE") {
      reportBackgroundStage("bg_message_received", {
        traceId: cleanText(message?.payload?.traceId || ""),
        type: message.type,
        batchIndex: Number(message?.payload?.batchIndex) || 0,
        bookmarkCount: Array.isArray(message?.payload?.bookmarks)
          ? message.payload.bookmarks.length
          : 0
      });
      const result = await enqueueBatch(message.payload || {});
      sendResponse(result);
      return;
    }

    if (message.type === "INGEST_FLUSH") {
      await flushQueue();
      sendResponse({
        ok: state.queue.length === 0,
        pendingQueue: state.queue.length
      });
      return;
    }

    if (message.type === "BOOKMARK_SCANNER_FETCH_IDS") {
      const result = await fetchBookmarkScannerSavedIds();
      sendResponse(result);
      return;
    }

    if (message.type === "BOOKMARK_SCANNER_IMPORT_BATCH") {
      const result = await importBookmarkScannerPending(
        message?.payload?.items,
        message?.payload?.source, message?.payload?.jobId, message?.payload?.namespace, message?.payload?.requestId, message?.payload?.requestIds
      );
      sendResponse(result);
      return;
    }

    if (message.type === "RELOOKUP_DENSE") {
      if (message?.payload?.reset === true) {
        await chrome.storage.local.set({ [RELOOKUP_STATE_KEY]: {} });
      }
      const result = await runFirstCommentRelookupPass("manual");
      sendResponse(result);
      return;
    }

    if (message.type === "RETRY_FAILED") {
      const result = await retryFailedQueueItems();
      sendResponse({ ok: true, ...result });
      return;
    }

    if (message.type === "GET_SETTINGS") {
      const settings = await getSettings();
      sendResponse({
        ok: true,
        ...settings,
        apiKey: fromPopup ? settings.apiKey : undefined,
        pendingQueue: state.queue.length
      });
      return;
    }

    if (message.type === "SETTINGS_UPDATE") {
      const updatedSettings = await updateSettings(message.payload || {});
      safeSendMessage({ type: "SETTINGS_CHANGED" });
      sendResponse({
        ok: true,
        ...updatedSettings
      });
      return;
    }

    if (message.type === "DIAGNOSTICS") {
      const settings = await getSettings();
      const bytesInUse = await new Promise((resolve) => {
        try {
          chrome.storage.local.getBytesInUse(null, (bytes) => {
            resolve(chrome.runtime.lastError ? -1 : bytes);
          });
        } catch (_error) {
          resolve(-1);
        }
      });
      const failed = state.failed;
      const head = state.queue[0] || null;
      const lastFailed = failed[failed.length - 1] || null;

      sendResponse({
        ok: true,
        apiBaseUrl: settings.apiBaseUrl,
        userId: settings.userId,
        apiKeyConfigured: Boolean(settings.apiKey),
        storageBytesInUse: bytesInUse,
        storageQuotaBytes: chrome.storage.local.QUOTA_BYTES ?? null,
        pendingQueue: state.queue.length,
        isFlushing: state.isFlushing,
        counters: { ...state.counters },
        queueHead: head
          ? {
              id: head.id || null,
              syncId: head.syncId || null,
              batchIndex: head.batchIndex ?? null,
              bookmarkCount: Array.isArray(head.bookmarks) ? head.bookmarks.length : 0,
              attempts: Number(head.attempts) || 0,
              queuedAt: head.queuedAt || null,
              lastError: head.lastError || null,
              prepared: Array.isArray(head.preparedBookmarks)
            }
          : null,
        failedQueue: failed.length,
        failedLast: lastFailed
          ? {
              id: lastFailed.id || null,
              failedAt: lastFailed.failedAt || null,
              attempts: Number(lastFailed.attempts) || 0,
              lastError: lastFailed.lastError || null
            }
          : null
      });
      return;
    }

    if (message.type === "GET_ACTIVITY") {
      sendResponse({
        ok: true,
        pendingQueue: state.queue.length,
        counters: { ...state.counters },
        activity: state.activity.slice(0, ACTIVITY_LOG_MAX)
      });
      return;
    }

    if (message.type === "CLEAR_ACTIVITY") {
      await changeDelivery(draft => { draft.activity = []; });
      updateBadge();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({
      ok: false,
      error: "unsupported_message_type"
    });
  })().catch((error) => {
    sendResponse({
      ok: false,
      error: extractErrorMessage(error) || "unknown_error",
      traceId: cleanText(message?.payload?.traceId || "")
    });
  });

  return true;
});

bootstrapQueue("top_level");
