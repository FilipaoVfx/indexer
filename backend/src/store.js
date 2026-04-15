import { createClient } from "@supabase/supabase-js";
import { normalizeBookmark } from "./normalize.js";
import { parseSearchQuery } from "./search-query.js";

function clampNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, minimum), maximum);
}

function escapeForOrLike(value) {
  return String(value || "")
    .replace(/[%*,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDomainFromUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "";
  }
}

export class BookmarkStore {
  constructor(config) {
    if (!config.supabaseUrl || !config.supabaseKey) {
      throw new Error(
        "Missing Supabase config. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SERVICE_ROLE_KEY)."
      );
    }
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);
    this.isReady = false;
  }

  async init() {
    if (this.isReady) {
      return;
    }
    // No explicit initialization needed for Supabase client
    this.isReady = true;
  }

  async upsertBatch({ userId, syncId, bookmarks, receivedAt }) {
    await this.init();

    let inserted = 0;
    let updated = 0;
    let ignoredInvalid = 0;

    const bookmarksToUpsert = [];

    for (const rawBookmark of bookmarks) {
      const normalized = normalizeBookmark(rawBookmark, {
        userId,
        syncId,
        receivedAt
      });

      if (!normalized.valid) {
        ignoredInvalid += 1;
        continue;
      }

      const bookmark = normalized.bookmark;
      bookmarksToUpsert.push({
        ...bookmark,
        inserted_at: receivedAt,
        updated_at: receivedAt
      });
    }

    if (bookmarksToUpsert.length > 0) {
      const { data, error } = await this.supabase
        .from("bookmarks")
        .upsert(bookmarksToUpsert, { onConflict: "id" })
        .select("id");

      if (error) {
        throw new Error(`Failed to upsert bookmarks: ${error.message}`);
      }

      // Supabase returns the upserted records. 
      // We can distinguish between inserted and updated if we query before, 
      // but for simplicity in a batch we'll count total successes.
      inserted = data.length;
    }

    const { count: totalStored } = await this.supabase
      .from("bookmarks")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);

    return {
      received: bookmarks.length,
      inserted,
      updated, // In Supabase upsert, we don't easily distinguish without extra checks
      ignored_invalid: ignoredInvalid,
      total_stored: totalStored
    };
  }

  async search({
    userId,
    q,
    author,
    domain,
    from,
    to,
    limit = 50,
    offset = 0
  }) {
    await this.init();

    const parsedQuery = parseSearchQuery({
      q,
      author,
      domain,
      from,
      to
    });
    const normalizedLimit = clampNumber(limit, 50, 1, 100);
    const normalizedOffset = clampNumber(offset, 0, 0, 10_000);
    const startedAt = Date.now();

    try {
      const { data, error } = await this.supabase.rpc("search_bookmarks", {
        search_query: parsedQuery.searchText || null,
        user_filter: userId || null,
        author_filter: parsedQuery.filters.author || null,
        domain_filter: parsedQuery.filters.domain || null,
        from_date: parsedQuery.filters.from || null,
        to_date: parsedQuery.filters.to || null,
        limit_count: normalizedLimit,
        offset_count: normalizedOffset
      });

      if (error) {
        throw error;
      }

      const items = (data || []).map((row) => ({
        id: row.id,
        user_id: row.user_id,
        sync_id: row.sync_id,
        tweet_id: row.tweet_id,
        text_content: row.text_content,
        author_username: row.author_username,
        author_name: row.author_name,
        created_at: row.created_at,
        links: row.links || [],
        media: row.media || [],
        source_url: row.source_url,
        ingested_at: row.ingested_at,
        updated_at: row.updated_at,
        inserted_at: row.inserted_at,
        source_domain: extractDomainFromUrl(row.source_url),
        highlight: row.highlight || null,
        score: Number(row.score || 0),
        score_breakdown: {
          lexical: Number(row.text_rank || 0),
          author: Number(row.author_boost || 0),
          freshness: Number(row.freshness_boost || 0)
        }
      }));

      return {
        total: Number(data?.[0]?.total_count || 0),
        items,
        parsed_query: parsedQuery,
        strategy: "fts",
        latency_ms: Date.now() - startedAt,
        warning: null
      };
    } catch (_rpcError) {
      const fallback = await this.searchFallback({
        userId,
        parsedQuery,
        limit: normalizedLimit,
        offset: normalizedOffset
      });

      return {
        ...fallback,
        strategy: "ilike_fallback",
        latency_ms: Date.now() - startedAt,
        warning:
          "FTS search function not available yet. Apply backend/sql/002_search_bookmarks.sql to enable ranked search."
      };
    }
  }

  async count() {
    await this.init();
    const { count, error } = await this.supabase
      .from("bookmarks")
      .select("*", { count: "exact", head: true });
    
    if (error) {
      throw new Error(`Failed to count bookmarks: ${error.message}`);
    }
    return count;
  }

  async searchFallback({ userId, parsedQuery, limit, offset }) {
    let queryBuilder = this.supabase
      .from("bookmarks")
      .select("*", { count: "exact" });

    if (userId) {
      queryBuilder = queryBuilder.eq("user_id", userId);
    }

    if (parsedQuery.filters.from) {
      queryBuilder = queryBuilder.gte("created_at", parsedQuery.filters.from);
    }

    if (parsedQuery.filters.to) {
      queryBuilder = queryBuilder.lte("created_at", parsedQuery.filters.to);
    }

    if (parsedQuery.filters.author) {
      const authorValue = escapeForOrLike(parsedQuery.filters.author);
      if (authorValue) {
        queryBuilder = queryBuilder.or(
          `author_username.ilike.%${authorValue}%,author_name.ilike.%${authorValue}%`
        );
      }
    }

    if (parsedQuery.filters.domain) {
      queryBuilder = queryBuilder.ilike(
        "source_url",
        `%${parsedQuery.filters.domain}%`
      );
    }

    if (parsedQuery.searchText) {
      const safeValue = escapeForOrLike(parsedQuery.searchText);
      if (safeValue) {
        queryBuilder = queryBuilder.or(
          `text_content.ilike.%${safeValue}%,author_username.ilike.%${safeValue}%,author_name.ilike.%${safeValue}%`
        );
      }
    }

    const { data, count, error } = await queryBuilder
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to search bookmarks: ${error.message}`);
    }

    return {
      total: count || 0,
      items: (data || []).map((row) => ({
        ...row,
        source_domain: extractDomainFromUrl(row.source_url),
        highlight: row.text_content || null,
        score: null,
        score_breakdown: null
      })),
      parsed_query: parsedQuery
    };
  }
}
