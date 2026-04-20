(() => {
  const BRIDGE_FLAG = "__xIndexerPageBridgeInstalled";
  const EVENT_NAME = "x-indexer:network-replies";
  const SOURCE = "x-indexer-page-bridge";
  const MAX_URLS_PER_TWEET = 30;
  const MAX_ENTRIES_PER_EVENT = 80;
  const SHORT_TEXT_LIMIT = 1200;
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
      const candidate = stripTrailingEllipsis(match[1] || "").replace(/[),.;:!?]+$/g, "");
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

    return !MEDIA_HOST_RE.test(parsed.hostname);
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
    const noteTweetText = getFirstString([
      tweetNode?.note_tweet?.note_tweet_results?.result?.text,
      tweetNode?.note_tweet?.note_tweet_results?.result?.note_tweet?.text,
      tweetNode?.legacy?.full_text,
      tweetNode?.legacy?.text
    ]);

    return noteTweetText.slice(0, SHORT_TEXT_LIMIT);
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

    if (!restId || !node?.legacy || typeof node.legacy !== "object") {
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
      tweetId: restId,
      inReplyToTweetId,
      conversationId: getFirstString([
        node?.legacy?.conversation_id_str,
        node?.legacy?.conversation_id
      ]),
      authorUsername,
      text,
      links,
      sortIndex: order,
      sourceUrl: authorUsername ? `https://x.com/${authorUsername}/status/${restId}` : ""
    };
  }

  function collectTweetEntries(root) {
    const entries = [];
    const seen = new Set();
    let order = 0;

    function visit(node) {
      if (!node || typeof node !== "object") {
        return;
      }

      if (Array.isArray(node)) {
        for (const item of node) {
          visit(item);
        }
        return;
      }

      const candidate = maybeExtractTweetEntry(node, order);
      if (candidate) {
        order += 1;
        if (!seen.has(candidate.tweetId)) {
          seen.add(candidate.tweetId);
          entries.push(candidate);
        }
      }

      for (const nestedValue of Object.values(node)) {
        if (nestedValue && typeof nestedValue === "object") {
          visit(nestedValue);
        }
      }
    }

    visit(root);
    return entries.slice(0, MAX_ENTRIES_PER_EVENT);
  }

  function shouldInspectUrl(url) {
    const normalized = cleanText(url);
    if (!normalized) {
      return false;
    }

    if (!/\/(?:i\/api|graphql)\//i.test(normalized)) {
      return false;
    }

    return /tweetdetail|conversation|timeline|bookmarks|byrestid|tweetresult/i.test(normalized);
  }

  function shouldInspectBody(bodyText) {
    return /in_reply_to_status_id(?:_str)?|tweet_results|conversationthread|threaded_conversation/i.test(
      String(bodyText || "")
    );
  }

  function emitEntries(entries, url) {
    if (!entries.length) {
      return;
    }

    window.dispatchEvent(new CustomEvent(EVENT_NAME, {
      detail: {
        source: SOURCE,
        url: cleanText(url),
        ts: Date.now(),
        entries
      }
    }));
  }

  function inspectBody(bodyText, url) {
    if (!shouldInspectUrl(url) || !shouldInspectBody(bodyText)) {
      return;
    }

    try {
      const payload = JSON.parse(bodyText);
      const entries = collectTweetEntries(payload).filter(
        (entry) => entry.inReplyToTweetId || entry.links.length > 0
      );
      emitEntries(entries, url);
    } catch (_error) {
      // Ignore non-JSON or unexpected payloads.
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function patchedFetch(...args) {
      const response = await originalFetch.apply(this, args);

      try {
        const url = cleanText(response?.url || args?.[0]?.url || args?.[0]);
        if (shouldInspectUrl(url)) {
          const cloned = response.clone();
          void cloned.text().then((text) => {
            inspectBody(text, url);
          }).catch(() => {});
        }
      } catch (_error) {
        // Ignore fetch inspection failures.
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
    this.addEventListener("load", () => {
      try {
        const url = cleanText(this.__xIndexerUrl || this.responseURL || "");
        const bodyText =
          typeof this.responseText === "string"
            ? this.responseText
            : typeof this.response === "string"
            ? this.response
            : "";

        if (bodyText) {
          inspectBody(bodyText, url);
        }
      } catch (_error) {
        // Ignore XHR inspection failures.
      }
    }, { once: true });

    return originalSend.apply(this, args);
  };
})();
