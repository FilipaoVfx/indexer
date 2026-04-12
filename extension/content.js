const SCRAPER_CONFIG = {
  batchSize: 25,
  minDelayMs: 1000,
  maxDelayMs: 2500,
  maxIdleRounds: 6,
  maxScrollRounds: 450
};

let isSyncRunning = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cleanText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\s+/g, " ").trim();
}

function safeEmit(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  } catch (_error) {
    // Ignore transient popup-not-open errors.
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

function buildSyncId() {
  return `sync-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
    if (!text) {
      continue;
    }
    if (text.startsWith("@") || text === "·") {
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
    if (!href) {
      continue;
    }
    links.add(href);
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

function extractVisibleTweets() {
  const tweetNodes = document.querySelectorAll('[data-testid="tweet"]');
  const tweets = [];

  for (const tweetNode of tweetNodes) {
    const extracted = extractTweetFromNode(tweetNode);
    if (extracted) {
      tweets.push(extracted);
    }
  }

  return tweets;
}

async function enqueueBatch(syncId, batchIndex, bookmarks) {
  const response = await sendRuntimeMessage({
    type: "INGEST_ENQUEUE",
    payload: {
      syncId,
      batchIndex,
      bookmarks
    }
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "enqueue_failed");
  }
}

async function runSync() {
  if (!window.location.pathname.includes("/i/bookmarks")) {
    throw new Error("Open https://x.com/i/bookmarks before sync.");
  }

  const syncId = buildSyncId();
  const seenTweetIds = new Set();
  const pendingBatch = [];
  let batchIndex = 0;
  let totalExtracted = 0;
  let totalEnqueued = 0;
  let idleRounds = 0;
  let scrollRounds = 0;

  safeEmit({
    type: "SYNC_PROGRESS",
    payload: {
      stage: "scraping_iniciado",
      syncId
    }
  });

  while (scrollRounds < SCRAPER_CONFIG.maxScrollRounds) {
    scrollRounds += 1;

    const visibleTweets = extractVisibleTweets();
    let discoveredThisRound = 0;

    for (const tweet of visibleTweets) {
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

    safeEmit({
      type: "SYNC_PROGRESS",
      payload: {
        stage: "scraping_en_progreso",
        syncId,
        scrollRounds,
        discoveredThisRound,
        totalExtracted,
        totalEnqueued
      }
    });

    idleRounds = discoveredThisRound === 0 ? idleRounds + 1 : 0;
    if (idleRounds >= SCRAPER_CONFIG.maxIdleRounds) {
      break;
    }

    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "smooth"
    });
    await sleep(randomBetween(SCRAPER_CONFIG.minDelayMs, SCRAPER_CONFIG.maxDelayMs));
  }

  if (pendingBatch.length > 0) {
    batchIndex += 1;
    const lastChunk = pendingBatch.splice(0, pendingBatch.length);
    await enqueueBatch(syncId, batchIndex, lastChunk);
    totalEnqueued += lastChunk.length;
  }

  const flushResponse = await sendRuntimeMessage({
    type: "INGEST_FLUSH",
    payload: {
      syncId
    }
  });

  const summary = {
    syncId,
    totalExtracted,
    totalEnqueued,
    totalBatches: batchIndex,
    pendingQueue: flushResponse && typeof flushResponse.pendingQueue === "number"
      ? flushResponse.pendingQueue
      : null
  };

  safeEmit({
    type: "SYNC_DONE",
    payload: summary
  });

  return summary;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "START_SYNC") {
    return false;
  }

  if (isSyncRunning) {
    sendResponse({
      ok: false,
      error: "sync_already_running"
    });
    return false;
  }

  isSyncRunning = true;

  runSync()
    .then((result) => {
      sendResponse({
        ok: true,
        result
      });
    })
    .catch((error) => {
      safeEmit({
        type: "SYNC_ERROR",
        payload: {
          stage: "sync_abortada",
          error: error instanceof Error ? error.message : String(error)
        }
      });
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => {
      isSyncRunning = false;
    });

  return true;
});