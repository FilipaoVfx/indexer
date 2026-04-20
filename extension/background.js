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
const SHORTENER_HOST_RE = /^(t\.co|bit\.ly|buff\.ly|ow\.ly|tinyurl\.com|goo\.gl|dlvr\.it|lnkd\.in|is\.gd|tr\.im|cutt\.ly|rebrand\.ly|shorturl\.at)$/i;

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

const resolvedUrlCache = new Map();

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

async function prepareBookmarksForDelivery(bookmarks) {
  const items = Array.isArray(bookmarks) ? bookmarks : [];
  const prepared = [];

  for (const bookmark of items) {
    if (!bookmark || typeof bookmark !== "object") {
      prepared.push(bookmark);
      continue;
    }

    const rawLinks = uniqueUrls([
      ...(Array.isArray(bookmark.links) ? bookmark.links : []),
      ...(Array.isArray(bookmark.first_comment_links) ? bookmark.first_comment_links : [])
    ]);

    if (rawLinks.length === 0) {
      prepared.push(bookmark);
      continue;
    }

    const resolved = await resolveUrls(rawLinks);
    const firstCommentLinks = uniqueUrls(
      (Array.isArray(bookmark.first_comment_links) ? bookmark.first_comment_links : []).map(
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
  const preparedBookmarks = await prepareBookmarksForDelivery(queueItem.bookmarks);
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

      while (!delivered && attemptsThisRun < MAX_RETRIES) {
        try {
          const backendResult = await postBatch(current);
          delivered = true;
          state.queue.shift();
          await persistQueue();

          state.counters.delivered += (current.bookmarks || []).length;
          await recordActivity({
            stage: "ingesta_confirmada",
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
              syncId: current.syncId,
              batchIndex: current.batchIndex,
              pendingQueue: state.queue.length,
              backendResult
            }
          });
        } catch (error) {
          attemptsThisRun += 1;
          current.attempts += 1;
          current.lastError = error instanceof Error ? error.message : String(error);
          await persistQueue();

          if (attemptsThisRun >= MAX_RETRIES) {
            state.counters.failed += 1;
            await recordActivity({
              stage: "ingesta_fallida",
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
                syncId: current.syncId,
                batchIndex: current.batchIndex,
                pendingQueue: state.queue.length,
                attempts: current.attempts,
                error: current.lastError
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
              syncId: current.syncId,
              batchIndex: current.batchIndex,
              attempt: current.attempts,
              retryInMs: waitMs
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

async function enqueueBatch(payload) {
  if (!payload || !Array.isArray(payload.bookmarks) || payload.bookmarks.length === 0) {
    throw new Error("payload.bookmarks must be a non-empty array");
  }

  await loadQueueState();

  state.queue.push({
    id: `${payload.syncId || "sync"}-${payload.batchIndex || 0}-${Date.now()}`,
    syncId: payload.syncId || null,
    batchIndex: Number(payload.batchIndex) || 0,
    userId: payload.userId || null,
    bookmarks: payload.bookmarks,
    attempts: 0,
    queuedAt: new Date().toISOString()
  });

  await persistQueue();

  state.counters.captured += payload.bookmarks.length;
  const firstTweetId = (payload.bookmarks[0] && payload.bookmarks[0].tweet_id) || null;
  await recordActivity({
    stage: "lote_encolado",
    syncId: payload.syncId || null,
    batchIndex: Number(payload.batchIndex) || 0,
    pendingQueue: state.queue.length,
    count: payload.bookmarks.length,
    tweetId: firstTweetId
  });
  logInfo("batch queued", {
    syncId: payload.syncId,
    batchIndex: payload.batchIndex,
    count: payload.bookmarks.length,
    pendingQueue: state.queue.length
  });

  safeSendMessage({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "lote_encolado",
      syncId: payload.syncId || null,
      batchIndex: Number(payload.batchIndex) || 0,
      pendingQueue: state.queue.length
    }
  });

  void flushQueue();

  return {
    ok: true,
    pendingQueue: state.queue.length
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
  void ensureDefaults();
  void loadQueueState().then(() => flushQueue());
});

chrome.runtime.onStartup.addListener(() => {
  void loadQueueState().then(() => flushQueue());
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
      error: error instanceof Error ? error.message : String(error)
    });
  });

  return true;
});

void loadQueueState().then(() => flushQueue());
