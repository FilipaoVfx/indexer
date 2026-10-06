(() => {
  const BRIDGE_FLAG = "__xIndexerPageBridgeInstalled";
  const EVENT_NAME = "x-indexer:network-replies";
  const SOURCE = "x-indexer-page-bridge";
  const MAX_URLS_PER_TWEET = 30;
  const MAX_ENTRIES_PER_EVENT = 80;
  // Note tweets can exceed 1200 chars; keep full text for RAG-quality capture.
  const SHORT_TEXT_LIMIT = 12000;
  const MAX_MEDIA_PER_TWEET = 8;
  const URL_TEXT_RE = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"')\]]*)?)/gi;
  const X_HOST_RE = /(^|\.)x\.com$|(^|\.)twitter\.com$/i;
  const MEDIA_HOST_RE = /(^|\.)pbs\.twimg\.com$/i;

  if (window[BRIDGE_FLAG]) {
    return;
  }
  window[BRIDGE_FLAG] = true;

  function cleanText(value) {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  function parseUrlSafe(value) {
    try {
      return new URL(value);
    } catch (_error) {
      return null;
    }
  }

  function ensureScheme(value) {
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  }

  function stripTrailingEllipsis(value) {
    return String(value || "").replace(/[\u2026]+$|\.{3,}$/g, "").trim();
  }

  function looksLikeUrlText(value) {
    if (!value || value.length < 4) return false;
    if (value.startsWith("@") || value.startsWith("#")) return false;
    return /[a-z0-9-]+\.[a-z]{2,}(\/|$)/i.test(value);
  }

  function extractUrlsFromText(value) {
    const text = cleanText(value);
    if (!text) {
      return [];
    }

    const urls = [];
    let match = null;

    while ((match = URL_TEXT_RE.exec(text)) !== null) {
      if (/[…]|\.\.\./.test(match[1] || "")) continue;
      const candidate = (match[1] || "").replace(/[),.;:!?]+$/g, "");
      if (!candidate || !looksLikeUrlText(candidate)) {
        continue;
      }
      urls.push(ensureScheme(candidate));
    }

    URL_TEXT_RE.lastIndex = 0;
    return urls;
  }

  function isInterestingUrl(value) {
    const parsed = parseUrlSafe(value);
    if (!parsed) {
      return false;
    }

    return /^(https?:)$/.test(parsed.protocol) && !MEDIA_HOST_RE.test(parsed.hostname);
  }

  function uniqueUrls(values, limit = MAX_URLS_PER_TWEET) {
    const result = [];
    const seen = new Set();

    for (const value of Array.isArray(values) ? values : []) {
      const normalized = cleanText(value);
      const parsed = parseUrlSafe(normalized);
      if (!parsed) {
        continue;
      }

      const canonical = parsed.toString();
      if (!isInterestingUrl(canonical) || seen.has(canonical)) {
        continue;
      }

      seen.add(canonical);
      result.push(canonical);

      if (result.length >= limit) {
        break;
      }
    }

    return result;
  }

  function getFirstExistingObject(candidates) {
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object") {
        return candidate;
      }
    }
    return null;
  }

  function getFirstString(candidates) {
    for (const candidate of candidates) {
      const value = cleanText(candidate);
      if (value) {
        return value;
      }
    }
    return "";
  }

  function collectUrlsFromUnknownValue(value, urls, depth = 0) {
    if (depth > 4 || value == null) {
      return;
    }

    if (typeof value === "string") {
      const trimmed = cleanText(value);
      const direct = parseUrlSafe(trimmed);
      if (direct) {
        urls.push(direct.toString());
      } else {
        for (const extracted of extractUrlsFromText(trimmed)) {
          urls.push(extracted);
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        collectUrlsFromUnknownValue(item, urls, depth + 1);
      }
      return;
    }

    if (typeof value !== "object") {
      return;
    }

    const interestingKeys = [
      "url",
      "expanded_url",
      "expanded",
      "string_value",
      "shortened_url",
      "vanity_url"
    ];

    for (const key of interestingKeys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        collectUrlsFromUnknownValue(value[key], urls, depth + 1);
      }
    }

    for (const nestedValue of Object.values(value)) {
      if (nestedValue && typeof nestedValue === "object") {
        collectUrlsFromUnknownValue(nestedValue, urls, depth + 1);
      }
    }
  }

  function getTweetText(tweetNode) {
    const values = [tweetNode?.note_tweet?.note_tweet_results?.result?.text,
      tweetNode?.note_tweet?.note_tweet_results?.result?.note_tweet?.text,
      tweetNode?.legacy?.full_text, tweetNode?.legacy?.text];
    return (values.find(value => typeof value === "string" && value.trim()) || "")
      .replace(/\r\n?/g, "\n").trim();
  }

  function getAuthorUsername(tweetNode) {
    const userResult = getFirstExistingObject([
      tweetNode?.core?.user_results?.result,
      tweetNode?.author?.result,
      tweetNode?.author_results?.result
    ]);

    return getFirstString([
      userResult?.legacy?.screen_name,
      userResult?.core?.screen_name,
      userResult?.screen_name
    ]).replace(/^@+/, "");
  }

  function getAuthorName(tweetNode) {
    const userResult = getFirstExistingObject([
      tweetNode?.core?.user_results?.result,
      tweetNode?.author?.result,
      tweetNode?.author_results?.result
    ]);

    return getFirstString([
      userResult?.legacy?.name,
      userResult?.core?.name,
      userResult?.name
    ]);
  }

  function getTweetMedia(tweetNode) {
    const media = [];
    const seen = new Set();
    const pools = [
      tweetNode?.legacy?.extended_entities?.media,
      tweetNode?.legacy?.entities?.media
    ];

    for (const pool of pools) {
      if (!Array.isArray(pool)) continue;
      for (const item of pool) {
        const url = cleanText(item?.media_url_https || item?.media_url || "");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        media.push(url);
        if (media.length >= MAX_MEDIA_PER_TWEET) return media;
      }
    }

    return media;
  }

  function getTweetLinks(tweetNode, text) {
    const urls = [];
    const legacyEntities = tweetNode?.legacy?.entities;

    if (Array.isArray(legacyEntities?.urls)) {
      for (const item of legacyEntities.urls) {
        urls.push(
          item?.expanded_url,
          item?.unwound_url,
          item?.url
        );
      }
    }

    if (Array.isArray(legacyEntities?.media)) {
      for (const item of legacyEntities.media) {
        urls.push(item?.expanded_url, item?.url, item?.media_url_https, item?.media_url);
      }
    }

    if (Array.isArray(legacyEntities?.user_mentions)) {
      for (const mention of legacyEntities.user_mentions) {
        const screenName = cleanText(mention?.screen_name).replace(/^@+/, "");
        if (screenName) {
          urls.push(`https://x.com/${screenName}`);
        }
      }
    }

    collectUrlsFromUnknownValue(tweetNode?.card?.legacy?.binding_values, urls);
    collectUrlsFromUnknownValue(tweetNode?.card, urls);
    collectUrlsFromUnknownValue(tweetNode?.quoted_status_permalink, urls);
    collectUrlsFromUnknownValue(tweetNode?.legacy?.quoted_status_permalink, urls);

    for (const extracted of extractUrlsFromText(text)) {
      urls.push(extracted);
    }

    return uniqueUrls(urls);
  }

  function maybeExtractTweetEntry(node, order) {
    if (!node || typeof node !== "object") {
      return null;
    }

    const restId = getFirstString([
      node?.rest_id,
      node?.legacy?.id_str,
      node?.id_str
    ]);

    if (node.__typename !== "Tweet" || !/^\d+$/.test(restId) || !node?.legacy || typeof node.legacy !== "object") {
      return null;
    }

    const text = getTweetText(node);
    const links = getTweetLinks(node, text);
    const authorUsername = getAuthorUsername(node);
    const inReplyToTweetId = getFirstString([
      node?.legacy?.in_reply_to_status_id_str,
      node?.legacy?.in_reply_to_status_id
    ]);

    return {
      entityType: "Tweet",
      tweetId: restId,
      inReplyToTweetId,
      conversationId: getFirstString([
        node?.legacy?.conversation_id_str,
        node?.legacy?.conversation_id
      ]),
      authorUsername,
      authorName: getAuthorName(node),
      createdAt: getFirstString([node?.legacy?.created_at]),
      media: getTweetMedia(node),
      text: text.slice(0, SHORT_TEXT_LIMIT),
      contentTruncated: text.length > SHORT_TEXT_LIMIT,
      links,
      sortIndex: order,
      sourceUrl: authorUsername ? `https://x.com/${authorUsername}/status/${restId}` : ""
    };
  }

  function unwrapTweet(node) {
    return node?.__typename === "TweetWithVisibilityResults" ? node.tweet : node;
  }

  function collectTweetEntries(root, bookmarksOnly = false) {
    const entries = [], seen = new Set();
    const add = (node, bookmarkOrder = "") => {
      const candidate = maybeExtractTweetEntry(unwrapTweet(node), entries.length);
      if (!candidate) return false;
      if (!seen.has(candidate.tweetId)) {
        if (bookmarkOrder) candidate.bookmarkOrder = String(bookmarkOrder);
        seen.add(candidate.tweetId); entries.push(candidate);
      }
      return true;
    };
    let recognized = false, terminal = false, cursor = "", unsupported = false;
    function visit(node, depth = 0) {
      if (!node || typeof node !== "object" || depth > 30) return;
      if (Array.isArray(node)) { node.forEach(value => visit(value, depth + 1)); return; }
      if (bookmarksOnly && Array.isArray(node.instructions)) {
        recognized = true;
        for (const instruction of node.instructions) {
          if (instruction.type === "TimelineTerminateTimeline" && instruction.direction === "Bottom") terminal = true;
          for (const entry of [...(instruction.entries || []), ...(instruction.entry ? [instruction.entry] : [])]) {
            if (entry.content?.cursorType === "Bottom") cursor = cleanText(entry.content.value);
            const item = entry.content?.itemContent;
            if (/^tweet-/.test(entry.entryId || "")) {
              const result = unwrapTweet(item?.tweet_results?.result);
              if (result?.__typename !== "Tweet" || !add(result, entry.sortIndex)) unsupported = true;
            }
            for (const moduleItem of entry.content?.items || []) {
              const content = moduleItem.item?.itemContent;
              if (/tweet-/.test(moduleItem.entryId || "")) {
                const result = unwrapTweet(content?.tweet_results?.result);
                if (result?.__typename !== "Tweet" || !add(result)) unsupported = true;
              }
            }
          }
        }
        return;
      }
      if (node.__typename === "User") return;
      if (node.__typename === "Tweet" || node.__typename === "TweetWithVisibilityResults") {
        if (!bookmarksOnly) add(node);
        return; // Quoted tweets and authors are context, never timeline membership.
      }
      for (const [key, value] of Object.entries(node)) {
        if (!['core', 'quoted_status_result', 'retweeted_status_result', 'legacy'].includes(key)) visit(value, depth + 1);
      }
    }
    visit(root);
    return { entries, recognized: bookmarksOnly ? recognized && !unsupported : entries.length > 0, terminal, cursor };
  }

  function shouldInspectUrl(url) {
    const normalized = cleanText(url);
    if (!normalized) {
      return false;
    }

    if (!/\/(?:i\/api|graphql)\//i.test(normalized)) {
      return false;
    }

    return /tweetdetail|conversation|timeline|bookmarks|byrestid|tweetresult|createbookmark|hometimeline|homelatesttimeline|usertweets|searchtimeline/i.test(normalized);
  }

  function shouldInspectBody(bodyText) {
    return /in_reply_to_status_id(?:_str)?|tweet_results|conversationthread|threaded_conversation/i.test(
      String(bodyText || "")
    );
  }

  function emitEntries(entries, url, timeline, extra = {}) {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: {
      source: SOURCE, protocol: 2, url: cleanText(url), ts: Date.now(),
      timeline: timeline || "", entries, ...extra
    } }));
  }
  function isBookmarksTimelineUrl(url) {
    return /\/graphql\/[^/]+\/Bookmarks(?:[/?]|$)/i.test(String(url || ""));
  }
  function inspectBody(bodyText, url, requestId = "") {
    if (!shouldInspectUrl(url)) return;
    const bookmarks = isBookmarksTimelineUrl(url);
    try {
      const payload = JSON.parse(bodyText);
      if (Array.isArray(payload.errors) && payload.errors.length) {
        emitEntries([], url, bookmarks ? "bookmarks" : "", { health: "api_error", pending: false, requestId });
        return;
      }
      const decoded = collectTweetEntries(payload, bookmarks);
      for (let start = 0; start < Math.max(1, decoded.entries.length); start += MAX_ENTRIES_PER_EVENT) {
        emitEntries(decoded.entries.slice(start, start + MAX_ENTRIES_PER_EVENT), url, bookmarks ? "bookmarks" : "",
          { health: decoded.recognized ? "ok" : "schema_unknown", pending: false, requestId,
            terminal: decoded.terminal, cursor: decoded.cursor });
      }
    } catch (_error) {
      emitEntries([], url, bookmarks ? "bookmarks" : "", { health: "decode_error", pending: false, requestId });
    }
  }

  window.addEventListener("x-indexer:bridge-ping", () => emitEntries([], "", "", { health: "ready" }));
  emitEntries([], "", "", { health: "ready" });
  let requestSequence = 0;
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(...args) {
      const requestUrl = cleanText(args?.[0]?.url || args?.[0]);
      const requestId = `fetch-${++requestSequence}`;
      if (isBookmarksTimelineUrl(requestUrl)) emitEntries([], requestUrl, "bookmarks", { pending: true, requestId });
      let response;
      try { response = await originalFetch.apply(this, args); }
      catch (error) {
        if (isBookmarksTimelineUrl(requestUrl)) emitEntries([], requestUrl, "bookmarks", { pending: false, requestId, health: "network_error" });
        throw error;
      }

      try {
        const url = cleanText(response?.url || args?.[0]?.url || args?.[0]);
        if (shouldInspectUrl(url)) {
          const cloned = response.clone();
          void cloned.text().then((text) => {
            inspectBody(text, url, requestId);
          }).catch(() => emitEntries([], requestUrl, isBookmarksTimelineUrl(requestUrl) ? "bookmarks" : "", { pending: false, requestId, health: "decode_error" }));
        }
      } catch (_error) {
        emitEntries([], requestUrl, isBookmarksTimelineUrl(requestUrl) ? "bookmarks" : "", { pending: false, requestId, health: "decode_error" });
      }

      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this.__xIndexerUrl = cleanText(url);
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    const requestId = `xhr-${++requestSequence}`;
    if (isBookmarksTimelineUrl(this.__xIndexerUrl)) emitEntries([], this.__xIndexerUrl, "bookmarks", { pending: true, requestId });
    for (const type of ["error", "abort", "timeout"]) this.addEventListener(type, () => {
      if (isBookmarksTimelineUrl(this.__xIndexerUrl)) emitEntries([], this.__xIndexerUrl, "bookmarks", { pending: false, requestId, health: "network_error" });
    }, { once: true });
    this.addEventListener("load", () => {
      try {
        const url = cleanText(this.__xIndexerUrl || this.responseURL || "");
        const bodyText =
          typeof this.responseText === "string"
            ? this.responseText
            : typeof this.response === "string"
            ? this.response
            : "";

        inspectBody(bodyText, url, requestId);
      } catch (_error) {
        emitEntries([], this.__xIndexerUrl, "bookmarks", { pending: false, requestId, health: "decode_error" });
      }
    }, { once: true });

    return originalSend.apply(this, args);
  };
})();
