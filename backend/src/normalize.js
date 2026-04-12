function asString(value, maxLength = 4000) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().slice(0, maxLength);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStringArray(values, maxItems = 30, maxLength = 1500) {
  const output = [];
  const seen = new Set();

  for (const value of values) {
    const normalized = asString(value, maxLength);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);

    if (output.length >= maxItems) {
      break;
    }
  }

  return output;
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function extractTweetId(value) {
  const candidate = asString(value, 300);
  if (!candidate) {
    return "";
  }

  const plainId = candidate.match(/^\d+$/);
  if (plainId) {
    return plainId[0];
  }

  const fromUrl = candidate.match(/status\/(\d+)/);
  return fromUrl ? fromUrl[1] : "";
}

function normalizeMediaArray(rawMedia) {
  const mediaCandidates = [];

  for (const item of asArray(rawMedia)) {
    if (typeof item === "string") {
      mediaCandidates.push(item);
      continue;
    }

    if (item && typeof item === "object") {
      const url = asString(item.url || item.src || item.poster, 1500);
      if (url) {
        mediaCandidates.push(url);
      }
    }
  }

  return uniqueStringArray(mediaCandidates, 30, 1500);
}

export function normalizeBookmark(rawBookmark, context) {
  if (!rawBookmark || typeof rawBookmark !== "object") {
    return {
      valid: false,
      reason: "bookmark_not_object"
    };
  }

  const sourceUrl = asString(rawBookmark.source_url || rawBookmark.url, 1500);
  const tweetId = extractTweetId(rawBookmark.tweet_id || sourceUrl);

  if (!tweetId) {
    return {
      valid: false,
      reason: "missing_tweet_id"
    };
  }

  const textContent = asString(
    rawBookmark.text || rawBookmark.text_content || "",
    12000
  );
  const authorUsername = asString(
    rawBookmark.author_username || rawBookmark.username,
    100
  ).replace(/^@/, "");
  const authorName = asString(rawBookmark.author_name, 300);
  const createdAt = normalizeTimestamp(rawBookmark.created_at);
  const links = uniqueStringArray(asArray(rawBookmark.links), 40, 1500);
  const media = normalizeMediaArray(rawBookmark.media);

  return {
    valid: true,
    bookmark: {
      id: `${context.userId}:${tweetId}`,
      user_id: context.userId,
      sync_id: context.syncId || null,
      tweet_id: tweetId,
      text_content: textContent,
      author_username: authorUsername,
      author_name: authorName,
      created_at: createdAt,
      links,
      media,
      source_url: sourceUrl || null,
      ingested_at: context.receivedAt,
      updated_at: context.receivedAt
    }
  };
}