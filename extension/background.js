const DEFAULT_API_BASE_URL = "https://indexer-hzto.onrender.com";
const DEFAULT_USER_ID = "local-user";
const QUEUE_STORAGE_KEY = "ingest_queue_v1";
const SETTINGS_KEYS = ["apiBaseUrl", "userId"];
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1200;

const state = {
  queue: [],
  loaded: false,
  isFlushing: false
};

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
  const current = await chrome.storage.local.get([QUEUE_STORAGE_KEY]);
  state.queue = Array.isArray(current[QUEUE_STORAGE_KEY]) ? current[QUEUE_STORAGE_KEY] : [];
  state.loaded = true;
}

async function persistQueue() {
  await chrome.storage.local.set({
    [QUEUE_STORAGE_KEY]: state.queue
  });
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

async function postBatch(queueItem) {
  const settings = await getSettings();
  const endpoint = `${sanitizeBaseUrl(settings.apiBaseUrl)}/api/bookmarks/batch`;
  const payload = {
    user_id: sanitizeUserId(queueItem.userId || settings.userId),
    sync_id: queueItem.syncId,
    batch_index: queueItem.batchIndex,
    bookmarks: queueItem.bookmarks
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
