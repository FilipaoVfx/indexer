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
    text: cleanText(textNode ? textNode.innerText || "" : ""),
    author_name: extractAuthorName(userNameNode),
    author_username: extractAuthorUsername(userNameNode),
    created_at: createdAt || null,
    links: extractLinks(tweetNode),
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

    const visibleTweets = await extractVisibleTweets(seenTweetIds);
    let discoveredThisRound = 0;

    for (const tweet of visibleTweets) {
      // Re-verify since index might change or duplicates
      if (seenTweetIds.has(tweet.tweet_id)) {
        continue;
      }
      seenTweetIds.add(tweet.tweet_id);
      pendingBatch.push(tweet);
      totalExtracted += 1;
      discoveredThisRound += 1;

      if (pendingBatch.length >= SCRAPER_CONFIG.batchSize) {
        batchIndex += 1;
        const chunk = pendingBatch.splice(0, SCRAPER_CONFIG.batchSize);
        await enqueueBatch(syncId, batchIndex, chunk);
        totalEnqueued += chunk.length;
      }
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
