import type { Bookmark } from "./api";

export interface BookmarkViewOptions {
  kind?: "" | "media" | "links";
  sort?: "" | "recent";
}

function toTimestamp(value?: string): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function matchesKind(item: Bookmark, kind: BookmarkViewOptions["kind"]) {
  if (kind === "media") return (item.media || []).length > 0;
  if (kind === "links") return (item.links || []).length > 0;
  return true;
}

export function applyBookmarkView(
  items: Bookmark[],
  { kind = "", sort = "" }: BookmarkViewOptions
) {
  const filtered = items.filter((item) => matchesKind(item, kind));
  if (sort !== "recent") return filtered;

  return [...filtered].sort(
    (a, b) => toTimestamp(b.created_at) - toTimestamp(a.created_at)
  );
}
