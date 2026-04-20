const AUTO_CAPTURE_CONFIG = {
  captureDelayMs: 700,
  retryDelayMs: 500,
  maxExtractRetries: 4,
  dedupeWindowMs: 12_000,
  runtimeRetryDelayMs: 250,
  runtimeMaxAttempts: 4,
  runtimeResponseTimeoutMs: 6_000,
  detailLookupPollMs: 500,
  detailLookupMaxAttempts: 8,
  detailLookupScrollStepPx: 960
};

const LOG_PREFIX = "[x-indexer]";
const PAGE_BRIDGE_EVENT_NAME = "x-indexer:network-replies";
const PAGE_BRIDGE_SOURCE = "x-indexer-page-bridge";
const PAGE_BRIDGE_SCRIPT_ID = "x-indexer-page-bridge-script";
const NETWORK_REPLY_CACHE_MAX = 200;
const NETWORK_REPLY_CACHE_PER_TWEET_MAX = 24;
const NETWORK_REPLY_WAIT_POLL_MS = 150;
const NETWORK_REPLY_INITIAL_WAIT_MS = 1200;
const NETWORK_REPLY_RECHECK_WAIT_MS = 250;

function logInfo(...args) {
  try { console.info(LOG_PREFIX, ...args); } catch (_e) {}
}
function logWarn(...args) {
  try { console.warn(LOG_PREFIX, ...args); } catch (_e) {}
}

const recentCapturedAtByTweet = new Map();
const networkReplyCache = new Map();
const debugEventHistory = [];
let autoBatchIndex = 0;
const autoSyncId = `auto-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
const DEBUG_EVENT_LIMIT = 60;
const RUNTIME_NOTICE_ID = "x-indexer-runtime-notice";
let autoCaptureDisabledReason = "";

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function createTraceId(prefix = "trace") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function safeJsonStringify(value, maxLength = 900) {
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

function buildPageDebugContext() {
  return {
    href: window.location.href,
    path: window.location.pathname,
    title: cleanText(document.title || "")
  };
}

function summarizeEventTarget(target) {
  if (!target || typeof target !== "object") {
    return {
      type: typeof target
    };
  }

  const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return {
      nodeType: target.nodeType || null
    };
  }

  return {
    tag: String(element.tagName || "").toLowerCase(),
    testId: cleanText(element.getAttribute("data-testid") || ""),
    role: cleanText(element.getAttribute("role") || ""),
    classes: cleanText(typeof element.className === "string" ? element.className : "").slice(0, 120),
    textPreview: cleanText(element.textContent || "").slice(0, 120)
  };
}

function buildTweetDebugSnapshot(tweet) {
  if (!tweet || typeof tweet !== "object") {
    return {};
  }

  return {
    tweetId: cleanText(tweet.tweet_id || ""),
    author: cleanText(tweet.author_username || ""),
    sourceUrl: cleanText(tweet.source_url || ""),
    textPreview: cleanText(tweet.text || tweet.text_content || "").slice(0, 220),
    linkCount: Array.isArray(tweet.links) ? tweet.links.length : 0,
    firstCommentLinkCount: Array.isArray(tweet.first_comment_links) ? tweet.first_comment_links.length : 0,
    mediaCount: Array.isArray(tweet.media) ? tweet.media.length : 0
  };
}

function rememberDebugEvent(level, stage, details = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    stage,
    ...buildPageDebugContext(),
    ...details
  };

  debugEventHistory.unshift(entry);
  if (debugEventHistory.length > DEBUG_EVENT_LIMIT) {
    debugEventHistory.length = DEBUG_EVENT_LIMIT;
  }

  try {
    window.__xIndexerDebugEvents = debugEventHistory.slice();
    window.__xIndexerLastDebugEvent = entry;
  } catch (_error) {
    // Ignore assignment failures.
  }

  if (level === "warn") {
    logWarn(stage, entry);
  } else {
    logInfo(stage, entry);
  }

  return entry;
}

function updateLastRuntimeFailure(details) {
  try {
    window.__xIndexerLastRuntimeFailure = {
      ts: new Date().toISOString(),
      ...details
    };
  } catch (_error) {
    // Ignore assignment failures.
  }
}

function disableAutoCapture(reason, details = {}) {
  if (autoCaptureDisabledReason) {
    return;
  }

  autoCaptureDisabledReason = extractErrorMessage(reason) || "auto_capture_disabled";

  try {
    document.removeEventListener("click", onDocumentClick, true);
    document.removeEventListener("keydown", onDocumentKeydown, true);
    window.__xIndexerAutoCaptureReady = false;
  } catch (_error) {
    // Ignore listener cleanup failures.
  }

  const message = formatRuntimeError(reason);
  showRuntimeNotice(message, details);
  rememberDebugEvent("warn", "auto_capture_disabled", {
    traceId: cleanText(details.traceId || ""),
    reason: message
  });
}

function cleanMultilineText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeForMatch(value) {
  return cleanText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeForLookup(value) {
  return normalizeForMatch(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeEmit(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Ignore popup-not-open errors.
  }
}

function isExtensionContextInvalidatedMessage(message) {
  return /Extension context invalidated/i.test(String(message || ""));
}

function isRetryableRuntimeErrorMessage(message) {
  if (isExtensionContextInvalidatedMessage(message)) {
    return false;
  }

  return /Receiving end does not exist|message port closed|The message port closed before a response was received|runtime_response_timeout|empty_runtime_response/i.test(
    String(message || "")
  );
}

function formatRuntimeError(error) {
  const message = extractErrorMessage(error);

  if (/Extension context invalidated/i.test(message)) {
    return (
      `${message}. Esto suele pasar cuando recargas la extension pero no la ` +
      `pestana de X. Recarga la pestana y vuelve a intentar.`
    );
  }

  if (/Receiving end does not exist/i.test(message)) {
    return (
      `${message}. El background de la extension no esta respondiendo todavia. ` +
      `Recarga la extension y luego la pestana de X.`
    );
  }

  if (/runtime_response_timeout/i.test(message)) {
    return (
      `El background no respondio a tiempo. La extension puede estar arrancando ` +
      `o reiniciandose. Intenta de nuevo en unos segundos y, si persiste, recarga la extension.`
    );
  }

  if (/empty_runtime_response/i.test(message)) {
    return (
      `El background respondio vacio. Normalmente pasa cuando el service worker ` +
      `se reinicia durante la captura. Intenta nuevamente.`
    );
  }

  return message;
}

function removeRuntimeNotice() {
  try {
    document.getElementById(RUNTIME_NOTICE_ID)?.remove();
  } catch (_error) {
    // Ignore DOM cleanup failures.
  }
}

function showRuntimeNotice(message, details = {}) {
  if (!document || !document.body) {
    return;
  }

  const traceId = cleanText(details.traceId || "");

  try {
    let container = document.getElementById(RUNTIME_NOTICE_ID);

    if (!container) {
      container = document.createElement("div");
      container.id = RUNTIME_NOTICE_ID;
      container.setAttribute("role", "status");
      container.style.position = "fixed";
      container.style.right = "16px";
      container.style.bottom = "16px";
      container.style.zIndex = "2147483647";
      container.style.maxWidth = "360px";
      container.style.padding = "12px 14px";
      container.style.borderRadius = "14px";
      container.style.background = "rgba(15, 23, 42, 0.96)";
      container.style.color = "#f8fafc";
      container.style.boxShadow = "0 18px 40px rgba(2, 6, 23, 0.35)";
      container.style.fontFamily = "ui-sans-serif, system-ui, sans-serif";
      container.style.fontSize = "13px";
      container.style.lineHeight = "1.45";
      container.style.border = "1px solid rgba(148, 163, 184, 0.25)";
      document.body.appendChild(container);
    }

    container.innerHTML = "";

    const title = document.createElement("div");
    title.textContent = "X Indexer necesita recargar esta pestana";
    title.style.fontWeight = "700";
    title.style.marginBottom = "6px";

    const body = document.createElement("div");
    body.textContent = message;
    body.style.opacity = "0.96";

    const meta = document.createElement("div");
    meta.textContent = traceId ? `traceId: ${traceId}` : "";
    meta.style.marginTop = "8px";
    meta.style.fontSize = "12px";
    meta.style.opacity = "0.72";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.marginTop = "10px";

    const reloadButton = document.createElement("button");
    reloadButton.type = "button";
    reloadButton.textContent = "Recargar ahora";
    reloadButton.style.border = "0";
    reloadButton.style.borderRadius = "999px";
    reloadButton.style.padding = "8px 12px";
    reloadButton.style.background = "#38bdf8";
    reloadButton.style.color = "#082f49";
    reloadButton.style.fontWeight = "700";
    reloadButton.style.cursor = "pointer";
    reloadButton.addEventListener("click", () => window.location.reload());

    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.textContent = "Cerrar";
    dismissButton.style.border = "1px solid rgba(148, 163, 184, 0.35)";
    dismissButton.style.borderRadius = "999px";
    dismissButton.style.padding = "8px 12px";
    dismissButton.style.background = "transparent";
    dismissButton.style.color = "#e2e8f0";
    dismissButton.style.cursor = "pointer";
    dismissButton.addEventListener("click", removeRuntimeNotice);

    actions.append(reloadButton, dismissButton);
    container.append(title, body);
    if (traceId) {
      container.append(meta);
    }
    container.append(actions);
  } catch (_error) {
    // Ignore DOM rendering failures.
  }
}

async function sendRuntimeMessage(message, meta = {}) {
  let lastError = null;
  const traceId = cleanText(meta.traceId || message?.payload?.traceId || "");
  const label = cleanText(meta.label || message?.type || "runtime_message");

  for (let attempt = 1; attempt <= AUTO_CAPTURE_CONFIG.runtimeMaxAttempts; attempt += 1) {
    rememberDebugEvent("info", "runtime_message_attempt", {
      traceId,
      label,
      attempt,
      maxAttempts: AUTO_CAPTURE_CONFIG.runtimeMaxAttempts
    });

    try {
      const response = await new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          reject(new Error("runtime_response_timeout"));
        }, AUTO_CAPTURE_CONFIG.runtimeResponseTimeoutMs);

        try {
          chrome.runtime.sendMessage(message, (nextResponse) => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeoutId);

            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }

            if (typeof nextResponse === "undefined") {
              reject(new Error("empty_runtime_response"));
              return;
            }

            resolve(nextResponse);
          });
        } catch (error) {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeoutId);
          reject(error);
        }
      });

      rememberDebugEvent("info", "runtime_message_response", {
        traceId,
        label,
        attempt,
        responsePreview: safeJsonStringify(response, 400)
      });
      return response;
    } catch (error) {
      lastError = error;
      const messageText = extractErrorMessage(error);
      const shouldRetry =
        attempt < AUTO_CAPTURE_CONFIG.runtimeMaxAttempts &&
        isRetryableRuntimeErrorMessage(messageText);
      const stage = shouldRetry
        ? "runtime_message_attempt_retrying"
        : "runtime_message_failed";
      const level = shouldRetry ? "info" : "warn";
      const formattedError = formatRuntimeError(error);

      rememberDebugEvent(level, stage, {
        traceId,
        label,
        attempt,
        maxAttempts: AUTO_CAPTURE_CONFIG.runtimeMaxAttempts,
        shouldRetry,
        retryInMs: shouldRetry ? AUTO_CAPTURE_CONFIG.runtimeRetryDelayMs : 0,
        error: formattedError,
        raw: safeJsonStringify(error, 500)
      });

      updateLastRuntimeFailure({
        traceId,
        label,
        attempt,
        maxAttempts: AUTO_CAPTURE_CONFIG.runtimeMaxAttempts,
        shouldRetry,
        retryInMs: shouldRetry ? AUTO_CAPTURE_CONFIG.runtimeRetryDelayMs : 0,
        error: formattedError,
        raw: safeJsonStringify(error, 500)
      });

      safeEmit({
        type: shouldRetry ? "SYNC_PROGRESS" : "SYNC_ERROR",
        payload: {
          stage,
          traceId,
          label,
          attempt,
          maxAttempts: AUTO_CAPTURE_CONFIG.runtimeMaxAttempts,
          shouldRetry,
          retryInMs: shouldRetry ? AUTO_CAPTURE_CONFIG.runtimeRetryDelayMs : 0,
          error: formattedError
        }
      });

      if (isExtensionContextInvalidatedMessage(messageText)) {
        disableAutoCapture(error, {
          traceId,
          label
        });
      }

      if (!shouldRetry) {
        break;
      }

      await sleep(AUTO_CAPTURE_CONFIG.runtimeRetryDelayMs);
    }
  }

  throw new Error(formatRuntimeError(lastError));
}

function extractTweetIdFromHref(href) {
  const normalized = cleanText(href);
  if (!normalized) {
    return "";
  }
  const match = normalized.match(/status\/(\d+)/);
  return match ? match[1] : "";
}

function extractAuthorUsername(userNameNode) {
  if (!userNameNode) {
    return "";
  }
  const profileLink = userNameNode.querySelector('a[href^="/"]');
  if (!profileLink || !profileLink.getAttribute("href")) {
    return "";
  }
  const href = profileLink.getAttribute("href");
  const match = href.match(/^\/([^/?#]+)/);
  return match ? match[1].replace(/^@/, "") : "";
}

function extractAuthorName(userNameNode) {
  if (!userNameNode) {
    return "";
  }
  const spans = Array.from(userNameNode.querySelectorAll("span"));
  for (const span of spans) {
    const text = cleanText(span.textContent || "");
    if (!text || text.startsWith("@")) {
      continue;
    }
    return text;
  }
  return "";
}

const SHORTENER_HOST_RE = /^(t\.co|bit\.ly|buff\.ly|ow\.ly|tinyurl\.com|goo\.gl|dlvr\.it|lnkd\.in|is\.gd|tr\.im|cutt\.ly|rebrand\.ly|shorturl\.at)$/i;
const TRAILING_ELLIPSIS_RE = /[\u2026]+$|\.{3,}$/;
const URL_TEXT_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"')\]]*)?)/gi;
const INTERNAL_X_HOST_RE = /(^|\.)x\.com$|(^|\.)twitter\.com$/i;
const INTERNAL_MEDIA_HOST_RE = /(^|\.)pbs\.twimg\.com$/i;
const CARD_IMAGE_SRC_RE = /pbs\.twimg\.com\/(?:card_img|semantic_core_img|amplify_video_thumb|ext_tw_video_thumb)\//i;
const FIRST_COMMENT_CUE_RE = /\b((?:1st|first)\s+(?:comment|reply)|primer\s+comentario|primera\s+respuesta|en\s+comentarios|en\s+las?\s+respuestas|in\s+the\s+comments|in\s+replies|reply\s+below|comments?\s+below)\b/i;
const RESOURCE_HINT_RE = /\b(repo+|repository|github|source|code|codigo|demo|link|links|enlace|enlaces|url|urls|gist|tutorial|readme|doc|docs|article|post|thread|prompt)\b/i;
const DOWNWARD_CUE_RE = /(?:\u{1F447}|\u2B07|\u2193|\bbelow\b|\babajo\b|\baca abajo\b|\baqui abajo\b|\bdown\b)/iu;
const REPLY_EXPAND_LABELS = [
  "show replies",
  "show more replies",
  "more replies",
  "view replies",
  "show probable spam",
  "mostrar respuestas",
  "mostrar mas respuestas",
  "mostrar más respuestas",
  "ver respuestas",
  "ver mas respuestas",
  "ver más respuestas",
  "mostrar probable spam"
];
const INTERNAL_X_RESERVED_PATHS = new Set([
  "home",
  "explore",
  "search",
  "notifications",
  "messages",
  "bookmarks",
  "jobs",
  "communities",
  "premium",
  "compose",
  "share",
  "settings",
  "login",
  "signup",
  "intent",
  "hashtag",
  "i"
]);

function stripTrailingEllipsis(value) {
  return value.replace(TRAILING_ELLIPSIS_RE, "").trim();
}

function looksLikeUrlText(value) {
  if (!value || value.length < 4) return false;
  if (value.startsWith("@") || value.startsWith("#")) return false;
  return /[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(value);
}

function ensureScheme(value) {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
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

function dedupeUrls(values, maxItems = 40) {
  const deduped = [];
  const seen = new Set();

  for (const value of Array.isArray(values) ? values : []) {
    const normalized = sanitizeAbsoluteUrl(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= maxItems) {
      break;
    }
  }

  return deduped;
}

function trimNetworkReplyCache() {
  while (networkReplyCache.size > NETWORK_REPLY_CACHE_MAX) {
    const oldestKey = networkReplyCache.keys().next().value;
    if (typeof oldestKey === "undefined") {
      break;
    }
    networkReplyCache.delete(oldestKey);
  }
}

function normalizeNetworkReplyCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const tweetId = cleanText(candidate.tweetId || candidate.tweet_id || candidate.rest_id || "");
  const inReplyToTweetId = cleanText(
    candidate.inReplyToTweetId || candidate.in_reply_to_tweet_id || candidate.parentTweetId || ""
  );

  if (!tweetId || !inReplyToTweetId) {
    return null;
  }

  return {
    tweetId,
    inReplyToTweetId,
    authorUsername: cleanText(candidate.authorUsername || candidate.author_username || "").replace(/^@+/, ""),
    text: cleanMultilineText(candidate.text || candidate.text_content || ""),
    links: dedupeUrls(candidate.links, 30),
    sourceUrl: sanitizeAbsoluteUrl(candidate.sourceUrl || candidate.source_url || ""),
    sortIndex: Number.isFinite(Number(candidate.sortIndex)) ? Number(candidate.sortIndex) : Number.MAX_SAFE_INTEGER,
    seenAt: Date.now()
  };
}

function rememberNetworkReplyCandidate(rawCandidate) {
  const candidate = normalizeNetworkReplyCandidate(rawCandidate);
  if (!candidate) {
    return false;
  }

  const key = candidate.inReplyToTweetId;
  const existing = networkReplyCache.get(key) || [];
  const next = existing.slice();
  const index = next.findIndex((entry) => entry.tweetId === candidate.tweetId);

  if (index >= 0) {
    next[index] = {
      ...next[index],
      ...candidate,
      links: dedupeUrls([
        ...(Array.isArray(next[index].links) ? next[index].links : []),
        ...candidate.links
      ], 30),
      seenAt: Date.now()
    };
  } else {
    next.push(candidate);
  }

  next.sort((a, b) => a.sortIndex - b.sortIndex || a.seenAt - b.seenAt);
  networkReplyCache.set(key, next.slice(0, NETWORK_REPLY_CACHE_PER_TWEET_MAX));
  trimNetworkReplyCache();
  return true;
}

function getNetworkReplyCandidates(tweetId) {
  return (networkReplyCache.get(String(tweetId || "")) || []).slice();
}

function scoreNetworkReplyCandidate(candidate, mainTweet) {
  const mainUser = String(mainTweet?.author_username || "").toLowerCase();
  const replyUser = String(candidate?.authorUsername || "").toLowerCase();
  const mainTweetSuggestsResource = textSuggestsLinksInReplies(
    mainTweet?.text || mainTweet?.text_content || ""
  );
  const candidateText = candidate?.text || "";

  let score = Math.max(0, 180 - (Number(candidate?.sortIndex) || 0));
  if (mainUser && replyUser && mainUser === replyUser) {
    score += 120;
  }
  if (Array.isArray(candidate?.links) && candidate.links.length > 0) {
    score += 80;
  }
  if (textSuggestsLinksInReplies(candidateText)) {
    score += 35;
  }
  if (RESOURCE_HINT_RE.test(normalizeForLookup(candidateText))) {
    score += 20;
  }
  if (mainTweetSuggestsResource && Array.isArray(candidate?.links) && candidate.links.length > 0) {
    score += 30;
  }

  return score;
}

function getNetworkFirstCommentLinks(mainTweet) {
  const candidates = getNetworkReplyCandidates(mainTweet?.tweet_id);
  if (candidates.length === 0) {
    return [];
  }

  const mainUser = String(mainTweet?.author_username || "").toLowerCase();
  const mainTweetSuggestsResource = textSuggestsLinksInReplies(
    mainTweet?.text || mainTweet?.text_content || ""
  );
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreNetworkReplyCandidate(candidate, mainTweet)
    }))
    .sort((a, b) => b.score - a.score || a.sortIndex - b.sortIndex);

  for (const candidate of ranked) {
    const replyUser = String(candidate.authorUsername || "").toLowerCase();
    const sameAuthor = Boolean(mainUser && replyUser && mainUser === replyUser);
    const links = dedupeUrls(candidate.links, 30);

    if (links.length === 0) {
      continue;
    }

    if (!mainUser || sameAuthor || mainTweetSuggestsResource) {
      return links;
    }
  }

  return [];
}

async function waitForNetworkFirstCommentLinks(mainTweet, timeoutMs = NETWORK_REPLY_INITIAL_WAIT_MS) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let sawCandidates = false;

  while (Date.now() <= deadline) {
    const candidates = getNetworkReplyCandidates(mainTweet?.tweet_id);
    if (candidates.length > 0) {
      sawCandidates = true;
      const links = getNetworkFirstCommentLinks(mainTweet);
      if (links.length > 0) {
        return links;
      }
    }

    if (Date.now() >= deadline) {
      break;
    }

    await sleep(NETWORK_REPLY_WAIT_POLL_MS);
  }

  return sawCandidates ? getNetworkFirstCommentLinks(mainTweet) : [];
}

function handlePageBridgeNetworkEvent(event) {
  const detail = event?.detail;
  if (!detail || detail.source !== PAGE_BRIDGE_SOURCE || !Array.isArray(detail.entries)) {
    return;
  }

  let storedCount = 0;
  for (const entry of detail.entries) {
    if (rememberNetworkReplyCandidate(entry)) {
      storedCount += 1;
    }
  }

  if (storedCount > 0) {
    rememberDebugEvent("info", "network_reply_batch_received", {
      url: cleanText(detail.url || "").slice(0, 220),
      entryCount: detail.entries.length,
      storedCount
    });
  }
}

function ensurePageBridgeInjected() {
  if (window.__xIndexerPageBridgeReady) {
    return;
  }

  window.__xIndexerPageBridgeReady = true;
  window.addEventListener(PAGE_BRIDGE_EVENT_NAME, handlePageBridgeNetworkEvent);

  const injectScript = () => {
    if (document.getElementById(PAGE_BRIDGE_SCRIPT_ID)) {
      return;
    }

    const target = document.head || document.documentElement;
    if (!target) {
      window.setTimeout(injectScript, 25);
      return;
    }

    try {
      const script = document.createElement("script");
      script.id = PAGE_BRIDGE_SCRIPT_ID;
      script.src = chrome.runtime.getURL("page-bridge.js");
      script.async = false;
      script.onload = () => {
        rememberDebugEvent("info", "page_bridge_injected", {});
      };
      script.onerror = () => {
        rememberDebugEvent("warn", "page_bridge_inject_failed", {});
      };
      target.appendChild(script);
    } catch (error) {
      rememberDebugEvent("warn", "page_bridge_inject_failed", {
        error: formatRuntimeError(error),
        raw: safeJsonStringify(error, 500)
      });
    }
  };

  injectScript();
}

function getAnchorHref(anchor) {
  const rawHref = cleanText(anchor.getAttribute("href") || "");
  if (/^https?:\/\//i.test(rawHref)) {
    return rawHref;
  }
  return cleanText(anchor.href || rawHref);
}

function isInternalXUrl(value) {
  const parsed = parseUrlSafe(value);
  return Boolean(parsed && INTERNAL_X_HOST_RE.test(parsed.hostname));
}

function isInternalPlatformAssetUrl(value) {
  const parsed = parseUrlSafe(value);
  return Boolean(
    parsed &&
    (INTERNAL_X_HOST_RE.test(parsed.hostname) || INTERNAL_MEDIA_HOST_RE.test(parsed.hostname))
  );
}

function getInternalXPathSegments(value) {
  const parsed = parseUrlSafe(value);
  if (!parsed || !INTERNAL_X_HOST_RE.test(parsed.hostname)) {
    return [];
  }

  return parsed.pathname
    .split("/")
    .map((segment) => cleanText(segment))
    .filter(Boolean);
}

function canonicalizeInternalXProfileUrl(value) {
  const segments = getInternalXPathSegments(value);
  if (segments.length !== 1) {
    return "";
  }

  const username = segments[0].replace(/^@+/, "");
  if (!username || INTERNAL_X_RESERVED_PATHS.has(username.toLowerCase())) {
    return "";
  }

  return `https://x.com/${username}`;
}

function isTweetTextMentionAnchor(anchor) {
  if (!anchor || typeof anchor.closest !== "function") {
    return false;
  }

  if (!anchor.closest('[data-testid="tweetText"]')) {
    return false;
  }

  const anchorText = cleanText(anchor.textContent || "");
  return /^@[a-z0-9_\.]+$/i.test(anchorText);
}

function pickLongerUrl(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = parseUrlSafe(candidate);
    if (!parsed) continue;
    if (!best || candidate.length > best.length) {
      best = candidate;
    }
  }
  return best;
}

function extractUrlCandidatesFromText(value) {
  const text = cleanText(value);
  if (!text) return [];

  const results = [];
  let match = null;

  while ((match = URL_TEXT_RE.exec(text)) !== null) {
    const candidate = stripTrailingEllipsis(match[1] || "").replace(/[),.;:!?]+$/g, "");
    if (!candidate || !looksLikeUrlText(candidate)) {
      continue;
    }
    results.push(ensureScheme(candidate));
  }

  URL_TEXT_RE.lastIndex = 0;
  return results;
}

function collectAnchorUrlCandidates(anchor) {
  // X often keeps the full URL in descendant spans even when the visible
  // fragment is ellipsized, so we inspect textContent plus accessibility attrs.
  const candidates = new Set();
  const rawSources = [
    anchor.textContent || "",
    anchor.getAttribute("aria-label") || "",
    anchor.getAttribute("title") || ""
  ];

  for (const source of rawSources) {
    for (const candidate of extractUrlCandidatesFromText(source)) {
      candidates.add(candidate);
    }
  }

  return Array.from(candidates);
}

function shouldCaptureExpandedLink(anchor, expandedUrl) {
  const parsed = parseUrlSafe(expandedUrl);
  if (!parsed || !/^https?:$/i.test(parsed.protocol)) {
    return false;
  }

  if (!isInternalPlatformAssetUrl(expandedUrl)) {
    return true;
  }

  if (isTweetTextMentionAnchor(anchor) && canonicalizeInternalXProfileUrl(expandedUrl)) {
    return true;
  }

  const textCandidates = collectAnchorUrlCandidates(anchor);
  return textCandidates.some((candidate) => !isInternalPlatformAssetUrl(candidate));
}

function normalizeCapturedLink(anchor, value) {
  const normalized = sanitizeAbsoluteUrl(value);
  if (!normalized) {
    return "";
  }

  if (isTweetTextMentionAnchor(anchor)) {
    const canonicalProfileUrl = canonicalizeInternalXProfileUrl(normalized);
    if (canonicalProfileUrl) {
      return canonicalProfileUrl;
    }
  }

  return normalized;
}

function collectElementUrlCandidates(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return [];
  }

  const candidates = new Set();
  const attributeNames = [
    "href",
    "src",
    "aria-label",
    "title",
    "data-url",
    "data-full-url",
    "data-expanded-url",
    "data-card-url"
  ];

  for (const attrName of attributeNames) {
    const rawValue = cleanText(element.getAttribute(attrName) || "");
    if (!rawValue) {
      continue;
    }

    const directUrl = parseUrlSafe(rawValue)
      ? rawValue
      : looksLikeUrlText(rawValue)
      ? ensureScheme(rawValue)
      : "";

    if (directUrl) {
      candidates.add(directUrl);
    }

    for (const extracted of extractUrlCandidatesFromText(rawValue)) {
      candidates.add(extracted);
    }
  }

  return Array.from(candidates);
}

function collectCardLinksFromContainer(container) {
  const urls = new Set();
  if (!container || container.nodeType !== Node.ELEMENT_NODE) {
    return [];
  }

  const anchorNodes = [];
  if (container.tagName === "A" && container.hasAttribute("href")) {
    anchorNodes.push(container);
  }

  for (const anchor of container.querySelectorAll("a[href]")) {
    anchorNodes.push(anchor);
  }

  for (const anchor of anchorNodes) {
    const expanded = expandUrlFromAnchor(anchor);
    if (expanded && shouldCaptureExpandedLink(anchor, expanded)) {
      urls.add(expanded);
    }
  }

  const candidateElements = [
    container,
    ...container.querySelectorAll("[href], [src], [aria-label], [title], [data-url], [data-full-url], [data-expanded-url], [data-card-url]")
  ];

  for (const element of candidateElements) {
    for (const candidate of collectElementUrlCandidates(element)) {
      if (!candidate || isInternalPlatformAssetUrl(candidate)) {
        continue;
      }
      const normalized = parseUrlSafe(candidate)
        ? candidate
        : looksLikeUrlText(candidate)
        ? ensureScheme(candidate)
        : "";
      if (normalized) {
        urls.add(normalized);
      }
    }
  }

  return Array.from(urls);
}

function findCardContainerFromNode(node, tweetNode) {
  let current = node;
  let depth = 0;

  while (current && current !== tweetNode && depth < 8) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const element = current;
      const dataTestId = cleanText(element.getAttribute("data-testid") || "");
      const role = cleanText(element.getAttribute("role") || "");
      const hasCardImage = Boolean(element.querySelector('img[src*="card_img"], img[src*="semantic_core_img"], img[src*="amplify_video_thumb"], img[src*="ext_tw_video_thumb"]'));

      if (/card/i.test(dataTestId) || role === "link" || hasCardImage) {
        const extracted = collectCardLinksFromContainer(element);
        if (extracted.length > 0) {
          return element;
        }
      }
    }

    current = current.parentElement;
    depth += 1;
  }

  return null;
}

function expandUrlFromAnchor(anchor) {
  const rawHref = getAnchorHref(anchor);
  if (!rawHref) return "";

  const parsedHref = parseUrlSafe(rawHref);
  const hrefIsShortener = Boolean(
    parsedHref && SHORTENER_HOST_RE.test(parsedHref.hostname)
  );
  const textCandidates = collectAnchorUrlCandidates(anchor);

  if (!hrefIsShortener) {
    // Even for direct links, prefer a longer display form if available.
    const best = pickLongerUrl([rawHref, ...textCandidates]);
    return best || rawHref;
  }

  // Shortener href: try to recover the expanded URL from the anchor subtree.
  const expanded = pickLongerUrl(textCandidates);
  return expanded || rawHref;
}

function extractCardLinks(tweetNode) {
  const urls = new Set();
  const candidateContainers = new Set();

  for (const wrapper of tweetNode.querySelectorAll('[data-testid^="card.wrapper"], [data-testid="card.wrapper"]')) {
    candidateContainers.add(wrapper);
  }

  for (const image of tweetNode.querySelectorAll("img[src]")) {
    const src = cleanText(image.getAttribute("src") || "");
    if (!CARD_IMAGE_SRC_RE.test(src)) {
      continue;
    }

    const anchor = image.closest("a[href]");
    if (anchor) {
      candidateContainers.add(anchor);
    }

    const wrapper = image.closest('[data-testid^="card.wrapper"], [data-testid="card.wrapper"]');
    if (wrapper) {
      candidateContainers.add(wrapper);
    }

    const cardContainer = findCardContainerFromNode(image, tweetNode);
    if (cardContainer) {
      candidateContainers.add(cardContainer);
    }
  }

  for (const container of candidateContainers) {
    for (const url of collectCardLinksFromContainer(container)) {
      urls.add(url);
    }
  }

  return Array.from(urls);
}

function extractLinks(tweetNode) {
  const links = new Set();
  const anchorNodes = tweetNode.querySelectorAll("a[href]");

  for (const anchor of anchorNodes) {
    const url = normalizeCapturedLink(anchor, expandUrlFromAnchor(anchor));
    if (url && shouldCaptureExpandedLink(anchor, url)) {
      links.add(url);
    }
  }

  for (const url of extractCardLinks(tweetNode)) {
    links.add(url);
  }

  return Array.from(links);
}

function textSuggestsLinksInReplies(value) {
  const normalized = normalizeForLookup(value);
  if (!normalized) {
    return false;
  }

  return (
    FIRST_COMMENT_CUE_RE.test(normalized) ||
    (DOWNWARD_CUE_RE.test(normalized) && RESOURCE_HINT_RE.test(normalized))
  );
}

function extractTweetNodeLookupText(tweetNode) {
  if (!tweetNode || tweetNode.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const textNode = tweetNode.querySelector('[data-testid="tweetText"]');
  if (textNode) {
    return cleanMultilineText(extractTweetTextWithExpandedUrls(textNode));
  }

  return cleanMultilineText(tweetNode.innerText || tweetNode.textContent || "");
}

function getReplyExpansionControls(root = document) {
  const controls = [];
  const seen = new Set();

  for (const element of root.querySelectorAll("button, [role='button'], a")) {
    const label = normalizeForLookup(
      [
        element.textContent || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || ""
      ].join(" ")
    );

    if (!label) {
      continue;
    }

    if (!REPLY_EXPAND_LABELS.some((candidate) => label.includes(candidate))) {
      continue;
    }

    if (seen.has(element)) {
      continue;
    }

    seen.add(element);
    controls.push(element);
  }

  return controls;
}

async function expandReplyThreads(root = document) {
  let clicked = 0;

  for (const control of getReplyExpansionControls(root)) {
    try {
      control.click();
      clicked += 1;
      await sleep(180);
    } catch (_error) {
      // Ignore transient DOM click failures.
    }

    if (clicked >= 4) {
      break;
    }
  }

  return clicked;
}

function extractMedia(tweetNode) {
  const media = new Set();

  const imageNodes = tweetNode.querySelectorAll("img[src]");
  for (const image of imageNodes) {
    const src = cleanText(image.getAttribute("src") || "");
    if (src) {
      media.add(src);
    }
  }

  const videoNodes = tweetNode.querySelectorAll("video");
  for (const video of videoNodes) {
    const poster = cleanText(video.getAttribute("poster") || "");
    if (poster) {
      media.add(poster);
    }

    const source = video.querySelector("source[src]");
    if (source) {
      const src = cleanText(source.getAttribute("src") || "");
      if (src) {
        media.add(src);
      }
    }
  }

  return Array.from(media);
}

function extractTweetTextWithExpandedUrls(textNode) {
  if (!textNode) return "";

  const pieces = [];

  function walk(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push(node.nodeValue || "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName;
    if (tag === "A") {
      const expanded = expandUrlFromAnchor(node);
      if (expanded) {
        pieces.push(expanded);
      } else {
        pieces.push(node.textContent || "");
      }
      return;
    }
    if (tag === "IMG") {
      // X renders emojis as <img alt="😀">.
      const alt = node.getAttribute("alt");
      if (alt) pieces.push(alt);
      return;
    }
    if (tag === "BR") {
      pieces.push("\n");
      return;
    }

    for (const child of node.childNodes) {
      walk(child);
    }
  }

  walk(textNode);
  return cleanMultilineText(pieces.join(""));
}

async function extractTweetFromNode(tweetNode) {
  const statusLink = tweetNode.querySelector('a[href*="/status/"]');
  if (!statusLink) {
    return null;
  }

  const sourceUrl = cleanText(statusLink.href || "");
  const tweetId = extractTweetIdFromHref(sourceUrl);
  if (!tweetId) {
    return null;
  }

  // Expansion logic for "Show more" / "Mostrar más"
  const buttons = Array.from(tweetNode.querySelectorAll('[role="button"]'));
  const showMoreButton = buttons.find(b => {
    const txt = b.innerText.toLowerCase();
    return txt.includes("show more") || txt.includes("mostrar más");
  });

  if (showMoreButton) {
    showMoreButton.click();
    // Wait for DOM update
    await sleep(400);
  }

  const textNode = tweetNode.querySelector('[data-testid="tweetText"]');
  const userNameNode = tweetNode.querySelector('[data-testid="User-Name"]');
  const timeNode = tweetNode.querySelector("time");
  const createdAt = cleanText(timeNode ? timeNode.getAttribute("datetime") || "" : "");

  return {
    tweet_id: tweetId,
    text: extractTweetTextWithExpandedUrls(textNode),
    author_name: extractAuthorName(userNameNode),
    author_username: extractAuthorUsername(userNameNode),
    created_at: createdAt || null,
    links: extractLinks(tweetNode),
    first_comment_links: [],
    media: extractMedia(tweetNode),
    source_url: sourceUrl
  };
}

function buildAnchorDebugSnapshot(anchor) {
  const expandedUrl = expandUrlFromAnchor(anchor);
  const normalizedUrl = normalizeCapturedLink(anchor, expandedUrl);

  return {
    text: cleanMultilineText(anchor.textContent || ""),
    rawHref: cleanText(anchor.getAttribute("href") || ""),
    href: cleanText(anchor.href || ""),
    ariaLabel: cleanMultilineText(anchor.getAttribute("aria-label") || ""),
    title: cleanMultilineText(anchor.getAttribute("title") || ""),
    expandedUrl,
    normalizedUrl,
    shouldCapture: Boolean(
      normalizedUrl && shouldCaptureExpandedLink(anchor, normalizedUrl)
    )
  };
}

function buildTweetTextDebugSnapshot(tweetNode) {
  const textNode = tweetNode?.querySelector?.('[data-testid="tweetText"]') || null;
  const anchors = textNode
    ? Array.from(textNode.querySelectorAll("a[href]")).map(buildAnchorDebugSnapshot)
    : [];

  return {
    hasTweetTextNode: Boolean(textNode),
    tweetTextHtml: textNode ? textNode.outerHTML : "",
    reconstructedText: textNode ? extractTweetTextWithExpandedUrls(textNode) : "",
    rawTextContent: textNode ? cleanMultilineText(textNode.textContent || "") : "",
    anchors
  };
}

function findInspectableTweetNode(tweetId) {
  const normalizedTweetId = cleanText(tweetId || "");
  if (normalizedTweetId) {
    return findTweetNodeByTweetId(normalizedTweetId);
  }

  const detailMatch = window.location.pathname.match(/\/status\/(\d+)/);
  if (detailMatch?.[1]) {
    return findTweetNodeByTweetId(detailMatch[1]);
  }

  return document.querySelector('article[data-testid="tweet"]');
}

function registerDebugHelpers() {
  if (window.__xIndexerDebugHelpersReady) {
    return;
  }

  window.__xIndexerDebugHelpersReady = true;
  window.__xIndexerInspectTweet = async (tweetId = "") => {
    const tweetNode = findInspectableTweetNode(tweetId);
    if (!tweetNode) {
      const missingResult = {
        ok: false,
        error: "tweet_not_found",
        tweetId: cleanText(tweetId || "")
      };
      logWarn("inspect_tweet_failed", missingResult);
      return missingResult;
    }

    const extracted = await extractTweetWithRetries(tweetNode);
    const textDebug = buildTweetTextDebugSnapshot(tweetNode);
    const replyCandidates = extracted
      ? getNetworkReplyCandidates(extracted.tweet_id).map((candidate) => ({
          tweetId: candidate.tweetId,
          inReplyToTweetId: candidate.inReplyToTweetId,
          authorUsername: candidate.authorUsername,
          text: candidate.text,
          links: candidate.links,
          sortIndex: candidate.sortIndex
        }))
      : [];

    const result = {
      ok: true,
      page: {
        href: window.location.href,
        path: window.location.pathname
      },
      tweet: extracted,
      textDebug,
      networkReplyCandidates: replyCandidates
    };

    try {
      window.__xIndexerLastInspection = result;
    } catch (_error) {
      // Ignore assignment failures.
    }

    logInfo("inspect_tweet_result", result);
    return result;
  };
}

async function extractVisibleTweets(seenTweetIds) {
  const tweetNodes = document.querySelectorAll('[data-testid="tweet"]');
  const tweets = [];

  for (const tweetNode of tweetNodes) {
    // Optimization: Check status link before potentially clicking expand
    const statusLink = tweetNode.querySelector('a[href*="/status/"]');
    if (!statusLink) continue;

    const tid = extractTweetIdFromHref(statusLink.href);
    if (!tid || seenTweetIds.has(tid)) continue;

    const extracted = await extractTweetFromNode(tweetNode);
    if (extracted) {
      tweets.push(extracted);
    }
  }

  return tweets;
}

function findTweetNodeByTweetId(tweetId) {
  if (!tweetId) return null;
  const tweetNodes = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));

  for (const tweetNode of tweetNodes) {
    const statusLink = tweetNode.querySelector('a[href*="/status/"]');
    if (!statusLink) continue;
    const currentTweetId = extractTweetIdFromHref(statusLink.href || "");
    if (currentTweetId && currentTweetId === String(tweetId)) {
      return tweetNode;
    }
  }

  return null;
}

async function tryExpandText(tweetNode) {
  const labels = ["mostrar mas", "show more", "read more"];
  const spans = tweetNode.querySelectorAll("span");

  for (const span of spans) {
    const label = normalizeForMatch(span.textContent || "");
    if (!labels.includes(label)) {
      continue;
    }

    const clickable = span.closest("button, [role='button'], a");
    if (!clickable) {
      continue;
    }

    try {
      clickable.click();
      await sleep(180);
    } catch (_error) {
      // Ignore.
    }
    return;
  }
}

async function extractTweetWithRetries(tweetNode) {
  for (let attempt = 1; attempt <= AUTO_CAPTURE_CONFIG.maxExtractRetries; attempt += 1) {
    await tryExpandText(tweetNode);
    const tweet = await extractTweetFromNode(tweetNode);
    if (tweet && tweet.tweet_id) {
      return tweet;
    }
    await sleep(AUTO_CAPTURE_CONFIG.retryDelayMs);
  }
  return null;
}

function findActionElement(target) {
  if (!target || typeof target.closest !== "function") {
    return null;
  }
  return target.closest('[data-testid="bookmark"]');
}

function isOnTweetDetailFor(tweetId) {
  const match = window.location.pathname.match(/\/status\/(\d+)/);
  return Boolean(match && tweetId && match[1] === String(tweetId));
}

function findFirstReplyNode(mainTweetNode) {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const idx = articles.indexOf(mainTweetNode);
  if (idx === -1) return null;
  return articles[idx + 1] || null;
}

function collectReplyCandidates(mainTweetNode, mainTweet) {
  const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
  const idx = articles.indexOf(mainTweetNode);
  if (idx === -1) return [];

  const mainUser = String(mainTweet?.author_username || "").toLowerCase();
  const mainTweetId = String(mainTweet?.tweet_id || "");
  const mainTweetSuggestsResource = textSuggestsLinksInReplies(
    mainTweet?.text || mainTweet?.text_content || ""
  );
  const candidates = [];

  for (let i = idx + 1; i < articles.length && i <= idx + 80; i += 1) {
    const candidate = articles[i];
    const statusLink = candidate.querySelector('a[href*="/status/"]');
    const candidateTweetId = extractTweetIdFromHref(statusLink ? statusLink.href || "" : "");
    if (!candidateTweetId || candidateTweetId === mainTweetId) {
      continue;
    }

    const userNameNode = candidate.querySelector('[data-testid="User-Name"]');
    const replyUser = String(extractAuthorUsername(userNameNode) || "").toLowerCase();
    const candidateText = extractTweetNodeLookupText(candidate);
    const candidateLinks = dedupeUrls([
      ...extractLinks(candidate),
      ...extractCardLinks(candidate)
    ]);
    const sameAuthor = Boolean(mainUser && replyUser && replyUser === mainUser);

    let score = Math.max(0, 220 - ((i - idx) * 6));
    if (sameAuthor) {
      score += 120;
    }
    if (candidateLinks.length > 0) {
      score += 90;
    }
    if (textSuggestsLinksInReplies(candidateText)) {
      score += 40;
    }
    if (RESOURCE_HINT_RE.test(normalizeForLookup(candidateText))) {
      score += 20;
    }
    if (mainTweetSuggestsResource && candidateLinks.length > 0) {
      score += 30;
    }

    candidates.push({
      node: candidate,
      tweetId: candidateTweetId,
      replyUser,
      sameAuthor,
      links: candidateLinks,
      distance: i - idx,
      score
    });
  }

  return candidates.sort(
    (a, b) => b.score - a.score || a.distance - b.distance
  );
}

async function collectSelfReplyLinks(mainTweetNode, mainTweet) {
  // Only merge self-reply links when we are on the main tweet's detail page;
  // on the timeline the "next" article is unrelated.
  if (!isOnTweetDetailFor(mainTweet.tweet_id)) {
    return [];
  }
  const networkLinks = getNetworkFirstCommentLinks(mainTweet);
  if (networkLinks.length > 0) {
    return networkLinks;
  }
  const mainUser = String(mainTweet.author_username || "").toLowerCase();
  const mainTweetSuggestsResource = textSuggestsLinksInReplies(
    mainTweet?.text || mainTweet?.text_content || ""
  );
  const candidates = collectReplyCandidates(mainTweetNode, mainTweet);

  if (candidates.length === 0) {
    const firstReplyNode = findFirstReplyNode(mainTweetNode);
    if (!firstReplyNode) {
      return [];
    }

    candidates.push({
      node: firstReplyNode,
      tweetId: "",
      replyUser: "",
      sameAuthor: false,
      links: dedupeUrls([
        ...extractLinks(firstReplyNode),
        ...extractCardLinks(firstReplyNode)
      ]),
      distance: 1,
      score: 0
    });
  }

  for (const candidate of candidates.slice(0, 12)) {
    const reply = await extractTweetWithRetries(candidate.node);
    const replyUser = String(reply?.author_username || candidate.replyUser || "").toLowerCase();
    const replyLinks = dedupeUrls([
      ...(Array.isArray(reply?.links) ? reply.links : []),
      ...candidate.links
    ]);

    if (replyLinks.length === 0) {
      continue;
    }

    const sameAuthor = Boolean(mainUser && replyUser && replyUser === mainUser) || candidate.sameAuthor;
    if (!mainUser || sameAuthor || mainTweetSuggestsResource) {
      return replyLinks;
    }
  }

  return [];
}

async function extractFirstCommentLinksFromDetailPage(tweetId) {
  const initialScrollY = window.scrollY;
  let expandClicks = 0;

  rememberDebugEvent("info", "detail_first_comment_lookup_started", {
    tweetId
  });

  for (
    let attempt = 1;
    attempt <= AUTO_CAPTURE_CONFIG.detailLookupMaxAttempts;
    attempt += 1
  ) {
    expandClicks += await expandReplyThreads(document);
    const tweetNode = findTweetNodeByTweetId(tweetId);
    if (tweetNode) {
      const tweet = await extractTweetWithRetries(tweetNode);
      if (tweet && tweet.tweet_id) {
        const networkLinks = await waitForNetworkFirstCommentLinks(
          tweet,
          attempt === 1 ? NETWORK_REPLY_INITIAL_WAIT_MS : NETWORK_REPLY_RECHECK_WAIT_MS
        );
        if (networkLinks.length > 0) {
          window.scrollTo(0, initialScrollY);
          rememberDebugEvent("info", "detail_first_comment_links_found_network", {
            tweetId,
            attempt,
            linkCount: networkLinks.length,
            expandClicks
          });
          return {
            ok: true,
            links: networkLinks,
            meta: {
              attempt,
              expandClicks,
              source: "network"
            }
          };
        }

        const links = await collectSelfReplyLinks(tweetNode, tweet);
        if (links.length > 0) {
          window.scrollTo(0, initialScrollY);
          rememberDebugEvent("info", "detail_first_comment_links_found", {
            tweetId,
            attempt,
            linkCount: links.length,
            expandClicks
          });
          return {
            ok: true,
            links,
            meta: {
              attempt,
              expandClicks,
              source: "dom"
            }
          };
        }
      }
    }

    const nextScrollY = Math.min(
      Math.max(
        document.documentElement.scrollHeight,
        document.body ? document.body.scrollHeight : 0
      ),
      window.scrollY + AUTO_CAPTURE_CONFIG.detailLookupScrollStepPx
    );
    window.scrollTo(0, nextScrollY);
    await sleep(AUTO_CAPTURE_CONFIG.detailLookupPollMs);
  }

  window.scrollTo(0, initialScrollY);
  rememberDebugEvent("warn", "detail_first_comment_links_empty", {
    tweetId,
    attempts: AUTO_CAPTURE_CONFIG.detailLookupMaxAttempts,
    expandClicks
  });
  return {
    ok: true,
    links: [],
    meta: {
      attempts: AUTO_CAPTURE_CONFIG.detailLookupMaxAttempts,
      expandClicks
    }
  };
}

function dedupeCapture(tweetId) {
  const now = Date.now();
  const last = recentCapturedAtByTweet.get(tweetId);
  if (typeof last === "number" && now - last < AUTO_CAPTURE_CONFIG.dedupeWindowMs) {
    return false;
  }
  recentCapturedAtByTweet.set(tweetId, now);
  const expiryCutoff = now - AUTO_CAPTURE_CONFIG.dedupeWindowMs * 4;
  for (const [id, ts] of recentCapturedAtByTweet) {
    if (ts < expiryCutoff) {
      recentCapturedAtByTweet.delete(id);
    }
  }
  return true;
}

async function enqueueSingleBookmark(tweet, source, traceId) {
  autoBatchIndex += 1;
  const bookmarkDebug = buildTweetDebugSnapshot(tweet);

  rememberDebugEvent("info", "enqueue_request_prepared", {
    traceId,
    source,
    syncId: autoSyncId,
    batchIndex: autoBatchIndex,
    tweet: bookmarkDebug
  });

  safeEmit({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "auto_capture_enqueue_started",
      traceId,
      source,
      syncId: autoSyncId,
      batchIndex: autoBatchIndex,
      tweetId: tweet.tweet_id,
      linkCount: bookmarkDebug.linkCount,
      firstCommentLinkCount: bookmarkDebug.firstCommentLinkCount
    }
  });

  const response = await sendRuntimeMessage({
    type: "INGEST_ENQUEUE",
    payload: {
      syncId: autoSyncId,
      batchIndex: autoBatchIndex,
      traceId,
      source,
      pageUrl: window.location.href,
      bookmarks: [tweet]
    }
  }, {
    traceId,
    label: "INGEST_ENQUEUE"
  });

  if (!response || !response.ok) {
    throw {
      message: response && response.error ? response.error : "enqueue_failed",
      traceId,
      source,
      tweetId: tweet.tweet_id,
      response
    };
  }

  rememberDebugEvent("info", "enqueue_request_accepted", {
    traceId,
    source,
    tweetId: tweet.tweet_id,
    pendingQueue: response.pendingQueue ?? null,
    queueItemId: cleanText(response.queueItemId || ""),
    backgroundTraceId: cleanText(response.traceId || "")
  });

  safeEmit({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "auto_capture_enqueued",
      traceId,
      source,
      tweetId: tweet.tweet_id,
      pendingQueue: response.pendingQueue,
      queueItemId: response.queueItemId || null
    }
  });
}

async function handleBookmarkSave(event, source) {
  if (autoCaptureDisabledReason) {
    return;
  }

  const actionElement = findActionElement(event.target);
  if (!actionElement) {
    return;
  }
  const traceId = createTraceId("cap");
  rememberDebugEvent("info", "bookmark_click_detected", {
    traceId,
    source,
    target: summarizeEventTarget(event.target)
  });
  safeEmit({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "auto_capture_detected",
      traceId,
      source
    }
  });

  const tweetNode = actionElement.closest('article[data-testid="tweet"]');
  if (!tweetNode) {
    rememberDebugEvent("warn", "bookmark_click_missing_article", {
      traceId,
      source,
      target: summarizeEventTarget(event.target)
    });
    return;
  }

  await sleep(AUTO_CAPTURE_CONFIG.captureDelayMs);
  const tweet = await extractTweetWithRetries(tweetNode);
  if (!tweet || !tweet.tweet_id) {
    rememberDebugEvent("warn", "tweet_extract_failed", {
      traceId,
      source
    });
    safeEmit({
      type: "SYNC_ERROR",
      payload: {
        stage: "auto_capture_extract_failed",
        traceId,
        source
      }
    });
    return;
  }
  rememberDebugEvent("info", "tweet_extracted", {
    traceId,
    source,
    tweet: buildTweetDebugSnapshot(tweet)
  });
  safeEmit({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "auto_capture_extracted",
      traceId,
      source,
      tweetId: tweet.tweet_id,
      author: tweet.author_username,
      linkCount: Array.isArray(tweet.links) ? tweet.links.length : 0
    }
  });

  if (!dedupeCapture(tweet.tweet_id)) {
    rememberDebugEvent("info", "tweet_capture_deduped", {
      traceId,
      source,
      tweetId: tweet.tweet_id
    });
    safeEmit({
      type: "SYNC_PROGRESS",
      payload: {
        stage: "auto_capture_deduped",
        traceId,
        source,
        tweetId: tweet.tweet_id
      }
    });
    return;
  }

  try {
    const extraLinks = await collectSelfReplyLinks(tweetNode, tweet);
    if (extraLinks.length > 0) {
      const merged = new Set((tweet.links || []).map(String));
      for (const link of extraLinks) {
        merged.add(String(link));
      }
      tweet.links = Array.from(merged);
      tweet.first_comment_links = extraLinks.slice();
      rememberDebugEvent("info", "self_reply_links_merged", {
        traceId,
        source,
        tweetId: tweet.tweet_id,
        addedLinks: extraLinks.length
      });
      safeEmit({
        type: "SYNC_PROGRESS",
        payload: {
          stage: "auto_capture_self_reply_merged",
          traceId,
          tweetId: tweet.tweet_id,
          addedLinks: extraLinks.length
        }
      });
    }
  } catch (error) {
    rememberDebugEvent("warn", "self_reply_lookup_failed", {
      traceId,
      source,
      tweetId: tweet.tweet_id,
      error: formatRuntimeError(error),
      raw: safeJsonStringify(error, 500)
    });
  }

  try {
    await enqueueSingleBookmark(tweet, source, traceId);
    rememberDebugEvent("info", "enqueue_completed", {
      traceId,
      source,
      tweetId: tweet.tweet_id
    });
  } catch (error) {
    const formattedError = formatRuntimeError(error);
    logWarn("enqueue failed", {
      traceId,
      tweetId: tweet.tweet_id,
      source,
      error: formattedError,
      raw: safeJsonStringify(error)
    });
    rememberDebugEvent("warn", "enqueue_failed", {
      traceId,
      source,
      tweetId: tweet.tweet_id,
      error: formattedError,
      raw: safeJsonStringify(error)
    });
    safeEmit({
      type: "SYNC_ERROR",
      payload: {
        stage: "auto_capture_enqueue_failed",
        traceId,
        source,
        tweetId: tweet.tweet_id,
        error: formattedError,
        debugEventCount: debugEventHistory.length
      }
    });
  }
}

function onDocumentClick(event) {
  void handleBookmarkSave(event, "click");
}

function onDocumentKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  void handleBookmarkSave(event, "keyboard");
}

function getAutoStatus() {
  return {
    mode: "auto_listener",
    syncId: autoSyncId,
    trackedTweets: recentCapturedAtByTweet.size,
    bulkScrapeInProgress
  };
}

const BULK_SCRAPE_CONFIG = {
  maxScrollRounds: 80,
  scrollIdleRounds: 4,
  scrollStepRatio: 0.85,
  roundDelayMs: 900,
  batchSize: 20
};

let bulkScrapeInProgress = false;

async function flushBulkBatch(pendingBatch, context, reason) {
  if (pendingBatch.length === 0) {
    return;
  }
  const batch = pendingBatch.splice(0, pendingBatch.length);
  autoBatchIndex += 1;
  const response = await sendRuntimeMessage(
    {
      type: "INGEST_ENQUEUE",
      payload: {
        syncId: autoSyncId,
        batchIndex: autoBatchIndex,
        traceId: context.traceId,
        source: "bulk_scrape",
        pageUrl: window.location.href,
        bookmarks: batch
      }
    },
    { traceId: context.traceId, label: "INGEST_ENQUEUE_BULK" }
  );

  if (!response || !response.ok) {
    throw new Error(
      response && response.error ? response.error : "bulk_enqueue_failed"
    );
  }

  context.totalEnqueued += batch.length;

  safeEmit({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "bulk_scrape_batch_enqueued",
      traceId: context.traceId,
      syncId: autoSyncId,
      batchIndex: autoBatchIndex,
      batchSize: batch.length,
      reason,
      totalExtracted: context.totalExtracted,
      totalEnqueued: context.totalEnqueued,
      pendingQueue: response.pendingQueue ?? null
    }
  });
}

async function runBulkScrape() {
  if (bulkScrapeInProgress) {
    return { ok: false, error: "bulk_scrape_already_running" };
  }
  if (autoCaptureDisabledReason) {
    return { ok: false, error: autoCaptureDisabledReason };
  }

  bulkScrapeInProgress = true;
  const traceId = createTraceId("bulk");
  const seen = new Set();
  const pendingBatch = [];
  const context = { traceId, totalExtracted: 0, totalEnqueued: 0 };
  let round = 0;
  let idleRounds = 0;

  const emitStage = (stage, extra = {}) => {
    safeEmit({
      type: "SYNC_PROGRESS",
      payload: {
        stage,
        traceId,
        syncId: autoSyncId,
        round,
        totalExtracted: context.totalExtracted,
        totalEnqueued: context.totalEnqueued,
        pendingBatch: pendingBatch.length,
        ...extra
      }
    });
  };

  try {
    if (!/\/i\/bookmarks/i.test(window.location.pathname)) {
      throw new Error("not_on_bookmarks_page");
    }

    logInfo("bulk_scrape_started", { traceId });
    emitStage("bulk_scrape_started");

    while (
      round < BULK_SCRAPE_CONFIG.maxScrollRounds &&
      idleRounds < BULK_SCRAPE_CONFIG.scrollIdleRounds
    ) {
      round += 1;
      const before = seen.size;
      const tweets = await extractVisibleTweets(seen);

      for (const tweet of tweets) {
        if (!tweet || !tweet.tweet_id || seen.has(tweet.tweet_id)) continue;
        seen.add(tweet.tweet_id);
        pendingBatch.push(tweet);
        context.totalExtracted += 1;
        if (pendingBatch.length >= BULK_SCRAPE_CONFIG.batchSize) {
          await flushBulkBatch(pendingBatch, context, "batch_full");
        }
      }

      const newThisRound = seen.size - before;
      emitStage("bulk_scrape_round", { roundTweets: newThisRound });

      if (newThisRound === 0) {
        idleRounds += 1;
      } else {
        idleRounds = 0;
      }

      window.scrollBy({
        top: Math.floor(window.innerHeight * BULK_SCRAPE_CONFIG.scrollStepRatio),
        left: 0,
        behavior: "auto"
      });
      await sleep(BULK_SCRAPE_CONFIG.roundDelayMs);
    }

    await flushBulkBatch(pendingBatch, context, "final");
    emitStage("bulk_scrape_completed");
    logInfo("bulk_scrape_completed", {
      traceId,
      totalExtracted: context.totalExtracted,
      totalEnqueued: context.totalEnqueued,
      rounds: round
    });
    return {
      ok: true,
      traceId,
      totalExtracted: context.totalExtracted,
      totalEnqueued: context.totalEnqueued,
      rounds: round
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn("bulk_scrape_error", { traceId, message });
    try {
      await flushBulkBatch(pendingBatch, context, "error_flush");
    } catch (_flushError) {
      // Ignore secondary flush failure.
    }
    emitStage("bulk_scrape_error", { error: message });
    return {
      ok: false,
      error: message,
      traceId,
      totalExtracted: context.totalExtracted,
      totalEnqueued: context.totalEnqueued,
      rounds: round
    };
  } finally {
    bulkScrapeInProgress = false;
  }
}

function registerAutoCaptureListeners() {
  if (window.__xIndexerAutoCaptureReady) {
    return;
  }
  window.__xIndexerAutoCaptureReady = true;

  document.addEventListener("click", onDocumentClick, true);
  document.addEventListener("keydown", onDocumentKeydown, true);

  safeEmit({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "auto_capture_ready",
      ...getAutoStatus()
    }
  });
  logInfo("auto-capture listener registered", getAutoStatus());
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "START_SYNC") {
    void runBulkScrape()
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    return true;
  }

  if (message.type === "GET_CAPTURE_STATUS") {
    sendResponse({
      ok: true,
      ...getAutoStatus()
    });
    return false;
  }

  if (message.type === "EXTRACT_FIRST_COMMENT_LINKS") {
    void extractFirstCommentLinksFromDetailPage(
      message.payload && message.payload.tweetId
    )
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          retryable: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    return true;
  }

  return false;
});

ensurePageBridgeInjected();
registerDebugHelpers();
registerAutoCaptureListeners();
