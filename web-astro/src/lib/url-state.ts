/**
 * Tiny URL-state hook. Keeps search filters shareable via query string.
 */
import { useCallback, useEffect, useState } from "react";

export type Filters = {
  mode: "hybrid" | "goal";
  user: string;
  q: string;
  author: string;
  domain: string;
  from: string;
  to: string;
  kind: "" | "media" | "links";
  sort: "" | "recent";
};

const VALID_KINDS = new Set<Filters["kind"]>(["", "media", "links"]);
const VALID_SORTS = new Set<Filters["sort"]>(["", "recent"]);
const VALID_MODES = new Set<Filters["mode"]>(["hybrid", "goal"]);

const EMPTY: Filters = {
  mode: "hybrid",
  user: "",
  q: "",
  author: "",
  domain: "",
  from: "",
  to: "",
  kind: "",
  sort: "",
};

function readUrl(): Filters {
  if (typeof window === "undefined") return { ...EMPTY };
  const p = new URLSearchParams(window.location.search);
  const rawMode = (p.get("mode") || "hybrid") as Filters["mode"];
  const rawKind = (p.get("kind") || "") as Filters["kind"];
  const rawSort = (p.get("sort") || "") as Filters["sort"];

  return {
    mode: VALID_MODES.has(rawMode) ? rawMode : "hybrid",
    user: p.get("user") || "",
    q: p.get("q") || "",
    author: p.get("author") || "",
    domain: p.get("domain") || "",
    from: p.get("from") || "",
    to: p.get("to") || "",
    kind: VALID_KINDS.has(rawKind) ? rawKind : "",
    sort: VALID_SORTS.has(rawSort) ? rawSort : "",
  };
}

function writeUrl(f: Filters) {
  const p = new URLSearchParams();
  if (f.mode && f.mode !== "hybrid") p.set("mode", f.mode);
  if (f.user) p.set("user", f.user);
  if (f.q) p.set("q", f.q);
  if (f.author) p.set("author", f.author);
  if (f.domain) p.set("domain", f.domain);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.kind) p.set("kind", f.kind);
  if (f.sort) p.set("sort", f.sort);
  const next = `${window.location.pathname}${p.toString() ? "?" + p.toString() : ""}`;
  window.history.replaceState({}, "", next);
}

export function useFilters(): [Filters, (patch: Partial<Filters>) => void, () => void] {
  const [filters, setFilters] = useState<Filters>(() => readUrl());

  useEffect(() => {
    const onPop = () => setFilters(readUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const update = useCallback((patch: Partial<Filters>) => {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      writeUrl(next);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setFilters(EMPTY);
    writeUrl(EMPTY);
  }, []);

  return [filters, update, reset];
}

export function hasAnySearchInput(f: Filters): boolean {
  return !!(f.user || f.q || f.author || f.domain || f.from || f.to || f.kind || f.sort);
}

export function hasRemoteSearchInput(f: Filters): boolean {
  if (f.mode === "goal") {
    return !!f.q.trim();
  }

  return !!(f.q || f.author || f.domain || f.from || f.to);
}

/** Absolute path builder that respects Astro base. */
export function withBase(path: string): string {
  const base =
    (typeof window !== "undefined" &&
      (document.querySelector('meta[name="astro-base"]') as HTMLMetaElement)?.content) ||
    "/indexer";
  const clean = path.startsWith("/") ? path : `/${path}`;
  return (base.replace(/\/$/, "") + clean).replace(/\/$/, "") || "/";
}
