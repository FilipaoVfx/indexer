const AUTO_CAPTURE_CONFIG = {
  captureDelayMs: 700,
  retryDelayMs: 500,
  maxExtractRetries: 4,
  dedupeWindowMs: 12_000,
  runtimeRetryDelayMs: 250,
  runtimeMaxAttempts: 2
};

const LOG_PREFIX = "[x-indexer]";

function logInfo(...args) {
  try { console.info(LOG_PREFIX, ...args); } catch (_e) {}
}
function logWarn(...args) {
  try { console.warn(LOG_PREFIX, ...args); } catch (_e) {}
}

const recentCapturedAtByTweet = new Map();
let autoBatchIndex = 0;
const autoSyncId = `auto-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
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

function isRetryableRuntimeErrorMessage(message) {
  return /Receiving end does not exist|message port closed|The message port closed before a response was received/i.test(
    String(message || "")
  );
}

function formatRuntimeError(error) {
  const message = error instanceof Error ? error.message : String(error || "");

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

  return message;
}

async function sendRuntimeMessage(message) {
  let lastError = null;

  for (let attempt = 1; attempt <= AUTO_CAPTURE_CONFIG.runtimeMaxAttempts; attempt += 1) {
    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (nextResponse) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(nextResponse);
        });
      });

      return response;
    } catch (error) {
      lastError = error;
      const messageText = error instanceof Error ? error.message : String(error || "");
      const shouldRetry =
        attempt < AUTO_CAPTURE_CONFIG.runtimeMaxAttempts &&
        isRetryableRuntimeErrorMessage(messageText);

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

  if (!isInternalXUrl(expandedUrl)) {
    return true;
  }

  const textCandidates = collectAnchorUrlCandidates(anchor);
  return textCandidates.some((candidate) => !isInternalXUrl(candidate));
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
  const urls = [];
  const cardWrapper = tweetNode.querySelector('[data-testid^="card.wrapper"], [data-testid="card.wrapper"]');
  if (cardWrapper) {
    const cardAnchor = cardWrapper.tagName === "A" ? cardWrapper : cardWrapper.querySelector("a[href]");
    if (cardAnchor) {
      const expanded = expandUrlFromAnchor(cardAnchor);
      if (expanded) urls.push(expanded);
    }
  }
  return urls;
}

function extractLinks(tweetNode) {
  const links = new Set();
  const anchorNodes = tweetNode.querySelectorAll("a[href]");

  for (const anchor of anchorNodes) {
    const url = expandUrlFromAnchor(anchor);
    if (url && shouldCaptureExpandedLink(anchor, url)) {
      links.add(url);
    }
  }

  for (const url of extractCardLinks(tweetNode)) {
    links.add(url);
  }

  return Array.from(links);
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

async function collectSelfReplyLinks(mainTweetNode, mainTweet) {
  // Only merge self-reply links when we are on the main tweet's detail page;
  // on the timeline the "next" article is unrelated.
  if (!isOnTweetDetailFor(mainTweet.tweet_id)) {
    return [];
  }
  const replyNode = findFirstReplyNode(mainTweetNode);
  if (!replyNode) return [];
  const reply = await extractTweetWithRetries(replyNode);
  if (!reply) return [];
  const mainUser = String(mainTweet.author_username || "").toLowerCase();
  const replyUser = String(reply.author_username || "").toLowerCase();
  if (!mainUser || mainUser !== replyUser) return [];
  return Array.isArray(reply.links) ? reply.links : [];
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

async function enqueueSingleBookmark(tweet, source) {
  autoBatchIndex += 1;
  const response = await sendRuntimeMessage({
    type: "INGEST_ENQUEUE",
    payload: {
      syncId: autoSyncId,
      batchIndex: autoBatchIndex,
      bookmarks: [tweet]
    }
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "enqueue_failed");
  }

  safeEmit({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "auto_capture_enqueued",
      source,
      tweetId: tweet.tweet_id,
      pendingQueue: response.pendingQueue
    }
  });
}

async function handleBookmarkSave(event, source) {
  const actionElement = findActionElement(event.target);
  if (!actionElement) {
    return;
  }
  logInfo("bookmark click detected", { source });

  const tweetNode = actionElement.closest('article[data-testid="tweet"]');
  if (!tweetNode) {
    logInfo("bookmark click but no article ancestor");
    return;
  }

  await sleep(AUTO_CAPTURE_CONFIG.captureDelayMs);
  const tweet = await extractTweetWithRetries(tweetNode);
  if (!tweet || !tweet.tweet_id) {
    logWarn("extract failed", { source });
    safeEmit({
      type: "SYNC_ERROR",
      payload: {
        stage: "auto_capture_extract_failed",
        source
      }
    });
    return;
  }
  logInfo("tweet extracted", {
    tweetId: tweet.tweet_id,
    author: tweet.author_username,
    links: (tweet.links || []).length
  });

  if (!dedupeCapture(tweet.tweet_id)) {
    logInfo("deduped (captured recently)", { tweetId: tweet.tweet_id });
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
      safeEmit({
        type: "SYNC_PROGRESS",
        payload: {
          stage: "auto_capture_self_reply_merged",
          tweetId: tweet.tweet_id,
          addedLinks: extraLinks.length
        }
      });
    }
  } catch (_error) {
    // Non-fatal; proceed with original links.
  }

  try {
    await enqueueSingleBookmark(tweet, source);
    logInfo("enqueued OK", { tweetId: tweet.tweet_id });
  } catch (error) {
    logWarn("enqueue failed", formatRuntimeError(error));
    safeEmit({
      type: "SYNC_ERROR",
      payload: {
        stage: "auto_capture_enqueue_failed",
        source,
        tweetId: tweet.tweet_id,
        error: formatRuntimeError(error)
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
    trackedTweets: recentCapturedAtByTweet.size
  };
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
    sendResponse({
      ok: false,
      error: "manual_sync_disabled_use_auto_capture"
    });
    return false;
  }

  if (message.type === "GET_CAPTURE_STATUS") {
    sendResponse({
      ok: true,
      ...getAutoStatus()
    });
    return false;
  }

  return false;
});

registerAutoCaptureListeners();
