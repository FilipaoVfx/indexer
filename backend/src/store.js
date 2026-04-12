import { createClient } from "@supabase/supabase-js";
import { normalizeBookmark } from "./normalize.js";

export class BookmarkStore {
  constructor(config) {
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
    from,
    to,
    limit = 50,
    offset = 0
  }) {
    await this.init();

    let queryBuilder = this.supabase
      .from("bookmarks")
      .select("*", { count: "exact" });

    if (userId) {
      queryBuilder = queryBuilder.eq("user_id", userId);
    }

    if (q) {
      queryBuilder = queryBuilder.or(`text_content.ilike.%${q}%,author_username.ilike.%${q}%,author_name.ilike.%${q}%`);
    }

    if (author) {
      queryBuilder = queryBuilder.or(`author_username.ilike.%${author}%,author_name.ilike.%${author}%`);
    }

    if (from) {
      queryBuilder = queryBuilder.gte("created_at", from);
    }

    if (to) {
      queryBuilder = queryBuilder.lte("created_at", to);
    }

    const { data, count, error } = await queryBuilder
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw new Error(`Failed to search bookmarks: ${error.message}`);
    }

    return {
      total: count,
      items: data || []
    };
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
}