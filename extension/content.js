const AUTO_CAPTURE_CONFIG = {
  captureDelayMs: 700,
  retryDelayMs: 500,
  maxExtractRetries: 4,
  dedupeWindowMs: 12_000
};

const recentCapturedAtByTweet = new Map();
let autoBatchIndex = 0;
const autoSyncId = `auto-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
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

function extractLinks(tweetNode) {
  const links = new Set();
  const anchorNodes = tweetNode.querySelectorAll('a[href^="http"]');

  for (const anchor of anchorNodes) {
    const href = cleanText(anchor.getAttribute("href") || "");
    if (href) {
      links.add(href);
    }
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

function extractTweetFromNode(tweetNode) {
  const statusLink = tweetNode.querySelector('a[href*="/status/"]');
  if (!statusLink) {
    return null;
  }

  const sourceUrl = cleanText(statusLink.href || "");
  const tweetId = extractTweetIdFromHref(sourceUrl);
  if (!tweetId) {
    return null;
  }

  const textNode = tweetNode.querySelector('[data-testid="tweetText"]');
  const userNameNode = tweetNode.querySelector('[data-testid="User-Name"]');
  const timeNode = tweetNode.querySelector("time");
  const createdAt = cleanText(timeNode ? timeNode.getAttribute("datetime") || "" : "");

  return {
    tweet_id: tweetId,
    text: cleanText(textNode ? textNode.innerText || "" : ""),
    author_name: extractAuthorName(userNameNode),
    author_username: extractAuthorUsername(userNameNode),
    created_at: createdAt || null,
    links: extractLinks(tweetNode),
    media: extractMedia(tweetNode),
    source_url: sourceUrl
  };
}

function findTweetNode(startNode) {
  if (!startNode || !(startNode instanceof Element)) {
    return null;
  }
  return (
    startNode.closest('article[data-testid="tweet"]') ||
    startNode.closest('[data-testid="tweet"]') ||
    startNode.closest("article")
  );
}

function findActionElement(startNode) {
  if (!startNode || !(startNode instanceof Element)) {
    return null;
  }
  return (
    startNode.closest('[data-testid="bookmark"]') ||
    startNode.closest('[data-testid="removeBookmark"]') ||
    startNode.closest("button, [role='button']")
  );
}

function classifyBookmarkAction(actionElement, rawTarget) {
  const dataTestId = normalizeForMatch(
    actionElement ? actionElement.getAttribute("data-testid") || "" : ""
  );
  if (dataTestId === "bookmark") {
    return "save";
  }
  if (dataTestId === "removebookmark") {
    return "remove";
  }

  const attrs = [
    actionElement ? actionElement.getAttribute("aria-label") || "" : "",
    actionElement ? actionElement.getAttribute("title") || "" : "",
    actionElement ? actionElement.textContent || "" : ""
  ]
    .map((value) => normalizeForMatch(value))
    .join(" ");

  if (
    attrs.includes("remove bookmark") ||
    attrs.includes("quitar marcador") ||
    attrs.includes("eliminar marcador")
  ) {
    return "remove";
  }

  if (
    attrs.includes("bookmark") ||
    attrs.includes("marcador") ||
    attrs.includes("guardar")
  ) {
    return "save";
  }

  if (
    rawTarget instanceof Element &&
    rawTarget.closest('path[d^="M4 4.5C4 3.12"]')
  ) {
    return "save";
  }

  return "unknown";
}

function dedupeCapture(tweetId) {
  const now = Date.now();
  const lastCapturedAt = recentCapturedAtByTweet.get(tweetId) || 0;
  if (now - lastCapturedAt < AUTO_CAPTURE_CONFIG.dedupeWindowMs) {
    return false;
  }

  recentCapturedAtByTweet.set(tweetId, now);

  if (recentCapturedAtByTweet.size > 250) {
    const threshold = now - AUTO_CAPTURE_CONFIG.dedupeWindowMs * 4;
    for (const [id, capturedAt] of recentCapturedAtByTweet.entries()) {
      if (capturedAt < threshold) {
        recentCapturedAtByTweet.delete(id);
      }
    }
  }

  return true;
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
    const tweet = extractTweetFromNode(tweetNode);
    if (tweet && tweet.tweet_id) {
      return tweet;
    }
    await sleep(AUTO_CAPTURE_CONFIG.retryDelayMs);
  }
  return null;
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
  const target = event.target;
  const actionElement = findActionElement(target);
  if (!actionElement) {
    return;
  }

  const actionType = classifyBookmarkAction(actionElement, target);
  if (actionType !== "save") {
    return;
  }

  const tweetNode = findTweetNode(actionElement);
  if (!tweetNode) {
    return;
  }

  await sleep(AUTO_CAPTURE_CONFIG.captureDelayMs);
  const tweet = await extractTweetWithRetries(tweetNode);
  if (!tweet || !tweet.tweet_id) {
    safeEmit({
      type: "SYNC_ERROR",
      payload: {
        stage: "auto_capture_extract_failed",
        source
      }
    });
    return;
  }

  if (!dedupeCapture(tweet.tweet_id)) {
    return;
  }

  try {
    await enqueueSingleBookmark(tweet, source);
  } catch (error) {
    safeEmit({
      type: "SYNC_ERROR",
      payload: {
        stage: "auto_capture_enqueue_failed",
        source,
        tweetId: tweet.tweet_id,
        error: error instanceof Error ? error.message : String(error)
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
