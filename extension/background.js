const DEFAULT_API_BASE_URL = "https://indexer-hzto.onrender.com";
const DEFAULT_USER_ID = "local-user";
const QUEUE_STORAGE_KEY = "ingest_queue_v1";
const ACTIVITY_STORAGE_KEY = "activity_log_v1";
const COUNTERS_STORAGE_KEY = "counters_v1";
const SETTINGS_KEYS = ["apiBaseUrl", "userId"];
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1200;
const ACTIVITY_LOG_MAX = 25;
const LOG_PREFIX = "[x-indexer:bg]";
const URL_RESOLVE_TIMEOUT_MS = 4500;
const MAX_URLS_PER_BOOKMARK = 40;
const DETAIL_LOOKUP_TIMEOUT_MS = 16_000;
const DETAIL_LOOKUP_MESSAGE_DELAY_MS = 900;
const DETAIL_LOOKUP_MESSAGE_MAX_ATTEMPTS = 6;
const FIRST_COMMENT_LOOKUP_CACHE_MAX = 200;
const SHORTENER_HOST_RE = /^(t\.co|bit\.ly|buff\.ly|ow\.ly|tinyurl\.com|goo\.gl|dlvr\.it|lnkd\.in|is\.gd|tr\.im|cutt\.ly|rebrand\.ly|shorturl\.at)$/i;
const FIRST_COMMENT_CUE_RE = /\b((?:1st|first)\s+(?:comment|reply)|primer\s+comentario|primera\s+respuesta|en\s+comentarios|en\s+las?\s+respuestas|in\s+the\s+comments|in\s+replies|reply\s+below|comments?\s+below)\b/i;
const RESOURCE_HINT_RE = /\b(repo+|repository|github|source|code|codigo|demo|link|links|enlace|enlaces|url|urls|gist|tutorial|readme|doc|docs|article|post|thread|prompt)\b/i;
const DOWNWARD_CUE_RE = /(?:\u{1F447}|\u2B07|\u2193|\bbelow\b|\babajo\b|\baca abajo\b|\baqui abajo\b|\bdown\b)/iu;

const state = {
  queue: [],
  activity: [],
  counters: { captured: 0, delivered: 0, failed: 0 },
  loaded: false,
  isFlushing: false
};

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
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Ignore popup-not-open errors.
  }
}

async function ensureDefaults() {
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
    userId: current.userId || DEFAULT_USER_ID
  };
}

async function loadQueueState() {
  if (state.loaded) {
    return;
  }

  await ensureDefaults();
  const current = await chrome.storage.local.get([
    QUEUE_STORAGE_KEY,
    ACTIVITY_STORAGE_KEY,
    COUNTERS_STORAGE_KEY
  ]);
  state.queue = Array.isArray(current[QUEUE_STORAGE_KEY]) ? current[QUEUE_STORAGE_KEY] : [];
  state.activity = Array.isArray(current[ACTIVITY_STORAGE_KEY])
    ? current[ACTIVITY_STORAGE_KEY]
    : [];
  const counters = current[COUNTERS_STORAGE_KEY];
  if (counters && typeof counters === "object") {
    state.counters = {
      captured: Number(counters.captured) || 0,
      delivered: Number(counters.delivered) || 0,
      failed: Number(counters.failed) || 0
    };
  }
  state.loaded = true;
  updateBadge();
}

async function persistQueue() {
  await chrome.storage.local.set({
    [QUEUE_STORAGE_KEY]: state.queue
  });
}

function updateBadge() {
  try {
    const pending = state.queue.length;
    const delivered = state.counters.delivered;
    if (pending > 0) {
      chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
      chrome.action.setBadgeText({ text: String(pending) });
    } else if (delivered > 0) {
      chrome.action.setBadgeBackgroundColor({ color: "#22c55e" });
      chrome.action.setBadgeText({ text: String(delivered) });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch (_error) {
    // action may not be available in some contexts.
  }
}

async function recordActivity(entry) {
  const enriched = {
    ts: Date.now(),
    ...entry
  };
  state.activity.unshift(enriched);
  if (state.activity.length > ACTIVITY_LOG_MAX) {
    state.activity.length = ACTIVITY_LOG_MAX;
  }
  try {
    await chrome.storage.local.set({
      [ACTIVITY_STORAGE_KEY]: state.activity,
      [COUNTERS_STORAGE_KEY]: state.counters
    });
  } catch (_error) {
    // Non-fatal.
  }
  updateBadge();
}

function sanitizeBaseUrl(value) {
  if (typeof value !== "string") {
    return DEFAULT_API_BASE_URL;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_API_BASE_URL;
}

function sanitizeUserId(value) {
  if (typeof value !== "string") {
    return DEFAULT_USER_ID;
  }
  const trimmed = value.trim().slice(0, 120);
  return trimmed || DEFAULT_USER_ID;
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
  return parsed ? parsed.toString() : "";
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
  firstCommentLookupCache.set(cacheKey, normalizedLinks);
  trimLookupCache(firstCommentLookupCache, FIRST_COMMENT_LOOKUP_CACHE_MAX);
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
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return promiseFactory(controller.signal)
    .finally(() => {
      clearTimeout(timeoutId);
    });
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

function replaceResolvedUrlsInText(text, mappings) {
  if (typeof text !== "string" || !text || !Array.isArray(mappings) || mappings.length === 0) {
    return text;
  }

  let output = text;
  for (const entry of mappings) {
    if (!entry || !entry.original || !entry.resolved || entry.original === entry.resolved) {
      continue;
    }
    output = output.split(entry.original).join(entry.resolved);
  }
  return output;
}

async function prepareBookmarksForDelivery(bookmarks, context = {}) {
  const items = Array.isArray(bookmarks) ? bookmarks : [];
  const prepared = [];
  const traceId = cleanText(context.traceId || "");

  for (const bookmark of items) {
    if (!bookmark || typeof bookmark !== "object") {
      prepared.push(bookmark);
      continue;
    }

    let firstCommentLinksRaw = uniqueUrls(bookmark.first_comment_links);

    if (firstCommentLinksRaw.length === 0 && shouldAttemptFirstCommentLookup(bookmark)) {
      firstCommentLinksRaw = await extractFirstCommentLinksViaDetailTab(bookmark, {
        traceId
      });
    }

    const rawLinks = uniqueUrls([
      ...(Array.isArray(bookmark.links) ? bookmark.links : []),
      ...firstCommentLinksRaw
    ]);

    if (rawLinks.length === 0) {
      prepared.push({
        ...bookmark,
        first_comment_links: firstCommentLinksRaw
      });
      continue;
    }

    const resolved = await resolveUrls(rawLinks);
    const firstCommentLinks = uniqueUrls(
      firstCommentLinksRaw.map(
        (url) =>
          resolved.mappings.find((entry) => entry.original === sanitizeAbsoluteUrl(url))?.resolved ||
          url
      )
    );

    const originalText =
      typeof bookmark.text === "string"
        ? bookmark.text
        : typeof bookmark.text_content === "string"
        ? bookmark.text_content
        : "";

    const nextText = replaceResolvedUrlsInText(originalText, resolved.mappings);

    prepared.push({
      ...bookmark,
      links: resolved.urls,
      first_comment_links: firstCommentLinks,
      ...(typeof bookmark.text === "string"
        ? { text: nextText }
        : typeof bookmark.text_content === "string"
        ? { text_content: nextText }
        : {})
    });
  }

  return prepared;
}

async function postBatch(queueItem) {
  const settings = await getSettings();
  const endpoint = `${sanitizeBaseUrl(settings.apiBaseUrl)}/api/bookmarks/batch`;
  reportBackgroundStage("bg_post_batch_started", {
    traceId: cleanText(queueItem.traceId || ""),
    queueItemId: cleanText(queueItem.id || ""),
    batchIndex: Number(queueItem.batchIndex) || 0,
    bookmarkCount: Array.isArray(queueItem.bookmarks) ? queueItem.bookmarks.length : 0
  }, {
    emit: true
  });

  const preparedBookmarks = await prepareBookmarksForDelivery(queueItem.bookmarks, {
    traceId: queueItem.traceId
  });

  reportBackgroundStage("bg_post_batch_prepared", {
    traceId: cleanText(queueItem.traceId || ""),
    queueItemId: cleanText(queueItem.id || ""),
    bookmarkCount: preparedBookmarks.length,
    firstBookmark: buildBookmarkDebugSnapshot(preparedBookmarks[0])
  });

  const payload = {
    user_id: sanitizeUserId(queueItem.userId || settings.userId),
    sync_id: queueItem.syncId,
    batch_index: queueItem.batchIndex,
    bookmarks: preparedBookmarks
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    reportBackgroundStage("bg_post_batch_http_error", {
      traceId: cleanText(queueItem.traceId || ""),
      queueItemId: cleanText(queueItem.id || ""),
      status: response.status,
      errorPreview: errorText.slice(0, 400)
    }, {
      level: "warn",
      emit: true
    });
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 400)}`);
  }

  return response.json();
}

async function flushQueue() {
  await loadQueueState();
  if (state.isFlushing) {
    return;
  }

  state.isFlushing = true;

  try {
    while (state.queue.length > 0) {
      const current = state.queue[0];
      current.attempts = Number(current.attempts) || 0;
      let delivered = false;
      let attemptsThisRun = 0;

       reportBackgroundStage("bg_flush_batch_started", {
        traceId: cleanText(current.traceId || ""),
        queueItemId: cleanText(current.id || ""),
        batchIndex: Number(current.batchIndex) || 0,
        queuedBookmarks: Array.isArray(current.bookmarks) ? current.bookmarks.length : 0,
        attemptsSoFar: current.attempts
      }, {
        emit: true
      });

      while (!delivered && attemptsThisRun < MAX_RETRIES) {
        try {
          const backendResult = await postBatch(current);
          delivered = true;
          state.queue.shift();
          await persistQueue();

          state.counters.delivered += (current.bookmarks || []).length;
          await recordActivity({
            stage: "ingesta_confirmada",
            traceId: current.traceId || null,
            syncId: current.syncId,
            batchIndex: current.batchIndex,
            pendingQueue: state.queue.length,
            count: (current.bookmarks || []).length
          });
          logInfo("batch delivered", {
            syncId: current.syncId,
            batchIndex: current.batchIndex,
            count: (current.bookmarks || []).length
          });

          safeSendMessage({
            type: "SYNC_PROGRESS",
            payload: {
              stage: "ingesta_confirmada",
              traceId: current.traceId || null,
              syncId: current.syncId,
              batchIndex: current.batchIndex,
              pendingQueue: state.queue.length,
              backendResult,
              queueItemId: current.id || null
            }
          });
        } catch (error) {
          attemptsThisRun += 1;
          current.attempts += 1;
          current.lastError = extractErrorMessage(error) || safeJsonStringify(error, 500);
          await persistQueue();

          reportBackgroundStage("bg_flush_attempt_failed", {
            traceId: current.traceId || null,
            queueItemId: current.id || null,
            batchIndex: current.batchIndex,
            attempt: current.attempts,
            error: current.lastError
          }, {
            level: "warn",
            emit: true
          });

          if (attemptsThisRun >= MAX_RETRIES) {
            state.counters.failed += 1;
            await recordActivity({
              stage: "ingesta_fallida",
              traceId: current.traceId || null,
              syncId: current.syncId,
              batchIndex: current.batchIndex,
              pendingQueue: state.queue.length,
              attempts: current.attempts,
              error: current.lastError
            });
            logWarn("batch failed after retries", {
              syncId: current.syncId,
              error: current.lastError
            });
            safeSendMessage({
              type: "SYNC_ERROR",
              payload: {
                stage: "ingesta_fallida",
                traceId: current.traceId || null,
                syncId: current.syncId,
                batchIndex: current.batchIndex,
                pendingQueue: state.queue.length,
                attempts: current.attempts,
                error: current.lastError,
                queueItemId: current.id || null
              }
            });
            break;
          }

          const waitMs =
            RETRY_BASE_DELAY_MS * attemptsThisRun + Math.floor(Math.random() * 500);
          safeSendMessage({
            type: "SYNC_PROGRESS",
            payload: {
              stage: "reintento_programado",
              traceId: current.traceId || null,
              syncId: current.syncId,
              batchIndex: current.batchIndex,
              attempt: current.attempts,
              retryInMs: waitMs,
              queueItemId: current.id || null
            }
          });
          await sleep(waitMs);
        }
      }

      if (!delivered) {
        break;
      }
    }
  } finally {
    state.isFlushing = false;
  }
}

function scheduleFlushQueue(reason) {
  void flushQueue().catch((error) => {
    reportAsyncError(`flush_queue_failed:${reason}`, error);
  });
}

function bootstrapQueue(reason) {
  void (async () => {
    await loadQueueState();
    await flushQueue();
  })().catch((error) => {
    reportAsyncError(`bootstrap_failed:${reason}`, error);
  });
}

async function enqueueBatch(payload) {
  if (!payload || !Array.isArray(payload.bookmarks) || payload.bookmarks.length === 0) {
    throw new Error("payload.bookmarks must be a non-empty array");
  }

  await loadQueueState();
  const traceId = cleanText(payload.traceId || "") || `bg-${Date.now().toString(36)}`;
  const queueItemId = `${payload.syncId || "sync"}-${payload.batchIndex || 0}-${Date.now()}`;

  state.queue.push({
    id: queueItemId,
    syncId: payload.syncId || null,
    traceId,
    batchIndex: Number(payload.batchIndex) || 0,
    userId: payload.userId || null,
    source: cleanText(payload.source || ""),
    pageUrl: cleanText(payload.pageUrl || ""),
    bookmarks: payload.bookmarks,
    attempts: 0,
    queuedAt: new Date().toISOString()
  });

  await persistQueue();

  state.counters.captured += payload.bookmarks.length;
  const firstTweetId = (payload.bookmarks[0] && payload.bookmarks[0].tweet_id) || null;
  await recordActivity({
    stage: "lote_encolado",
    traceId,
    syncId: payload.syncId || null,
    batchIndex: Number(payload.batchIndex) || 0,
    pendingQueue: state.queue.length,
    count: payload.bookmarks.length,
    tweetId: firstTweetId
  });
  reportBackgroundStage("bg_enqueue_received", {
    traceId,
    queueItemId,
    syncId: payload.syncId || null,
    batchIndex: Number(payload.batchIndex) || 0,
    source: cleanText(payload.source || ""),
    pageUrl: cleanText(payload.pageUrl || ""),
    pendingQueue: state.queue.length,
    firstBookmark: buildBookmarkDebugSnapshot(payload.bookmarks[0])
  }, {
    emit: true
  });

  safeSendMessage({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "lote_encolado",
      traceId,
      syncId: payload.syncId || null,
      batchIndex: Number(payload.batchIndex) || 0,
      pendingQueue: state.queue.length,
      queueItemId
    }
  });

  scheduleFlushQueue("enqueue_batch");

  return {
    ok: true,
    pendingQueue: state.queue.length,
    traceId,
    queueItemId
  };
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

chrome.runtime.onStartup.addListener(() => {
  bootstrapQueue("onStartup");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    await loadQueueState();

    if (!message || typeof message.type !== "string") {
      sendResponse({
        ok: false,
        error: "invalid_message"
      });
      return;
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

    if (message.type === "GET_SETTINGS") {
      const settings = await getSettings();
      sendResponse({
        ok: true,
        ...settings,
        pendingQueue: state.queue.length
      });
      return;
    }

    if (message.type === "SETTINGS_UPDATE") {
      const updatedSettings = await updateSettings(message.payload || {});
      sendResponse({
        ok: true,
        ...updatedSettings
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
      state.activity = [];
      state.counters = { captured: 0, delivered: 0, failed: 0 };
      await chrome.storage.local.set({
        [ACTIVITY_STORAGE_KEY]: [],
        [COUNTERS_STORAGE_KEY]: state.counters
      });
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
