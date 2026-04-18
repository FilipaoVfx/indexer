/**
 * AuthorsList — dedicated view listing all authors across the corpus.
 * Aligns with featureGoal.md §12.1 (entity-based exploration).
 */
import { useEffect, useMemo, useState } from "react";
import {
  extractAllAuthors,
  formatDate,
  getCorpus,
  initials,
  type AuthorEntity,
  type SearchItem,
} from "../lib/api";
import { withBase } from "../lib/url-state";

type SortKey = "count" | "latest" | "name";
type HistoryMode = "replace" | "push";

interface ViewState {
  q: string;
  sort: SortKey;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 24;
const PAGE_SIZE_OPTIONS = [24, 48, 96];
const VALID_SORTS = new Set<SortKey>(["count", "latest", "name"]);

function clampPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeState(state: ViewState): ViewState {
  return {
    q: state.q,
    sort: VALID_SORTS.has(state.sort) ? state.sort : "count",
    page: Math.max(1, state.page),
    pageSize: PAGE_SIZE_OPTIONS.includes(state.pageSize)
      ? state.pageSize
      : DEFAULT_PAGE_SIZE,
  };
}

function readViewState(): ViewState {
  if (typeof window === "undefined") {
    return {
      q: "",
      sort: "count",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const rawSort = (params.get("sort") || "count") as SortKey;

  return normalizeState({
    q: params.get("q") || "",
    sort: rawSort,
    page: clampPositiveInt(params.get("page"), 1),
    pageSize: clampPositiveInt(params.get("pageSize"), DEFAULT_PAGE_SIZE),
  });
}

function writeViewState(state: ViewState, historyMode: HistoryMode = "replace") {
  if (typeof window === "undefined") return;

  const next = normalizeState(state);
  const params = new URLSearchParams(window.location.search);

  if (next.q) params.set("q", next.q);
  else params.delete("q");

  if (next.sort !== "count") params.set("sort", next.sort);
  else params.delete("sort");

  if (next.page > 1) params.set("page", String(next.page));
  else params.delete("page");

  if (next.pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(next.pageSize));
  } else {
    params.delete("pageSize");
  }

  const nextUrl = `${window.location.pathname}${
    params.toString() ? `?${params.toString()}` : ""
  }`;

  if (historyMode === "push") {
    window.history.pushState({}, "", nextUrl);
  } else {
    window.history.replaceState({}, "", nextUrl);
  }
}

function getPageWindow(currentPage: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, totalPages, currentPage]);
  pages.add(Math.max(1, currentPage - 1));
  pages.add(Math.min(totalPages, currentPage + 1));

  if (currentPage <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }

  if (currentPage >= totalPages - 2) {
    pages.add(totalPages - 1);
    pages.add(totalPages - 2);
    pages.add(totalPages - 3);
  }

  const sorted = [...pages].filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
  const windowed: Array<number | "ellipsis"> = [];

  sorted.forEach((page, index) => {
    const previous = sorted[index - 1];
    if (previous && page - previous > 1) windowed.push("ellipsis");
    windowed.push(page);
  });

  return windowed;
}

function buildCollectionHref(path: "/authors" | "/repos", q: string, pageSize: number) {
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(pageSize));
  return withBase(`${path}${params.toString() ? `?${params.toString()}` : ""}`);
}

export default function AuthorsList() {
  const [items, setItems] = useState<SearchItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(() => readViewState());

  const { q, sort, page, pageSize } = view;

  useEffect(() => {
    getCorpus()
      .then((c) => {
        setItems(c.items);
        setTotal(c.total);
      })
      .catch((e) => setErr(e?.message || String(e)));
  }, []);

  useEffect(() => {
    const onPopState = () => setView(readViewState());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function updateView(patch: Partial<ViewState>, historyMode: HistoryMode = "replace") {
    setView((prev) => {
      const next = normalizeState({ ...prev, ...patch });
      writeViewState(next, historyMode);
      return next;
    });
  }

  const authors = useMemo<AuthorEntity[]>(() => {
    if (!items) return [];
    const list = [...extractAllAuthors(items).values()];
    const ql = q.trim().toLowerCase();
    const filtered = ql
      ? list.filter(
          (a) =>
            a.name.toLowerCase().includes(ql) ||
            (a.handle || "").toLowerCase().includes(ql)
        )
      : list;
    const sorters: Record<SortKey, (a: AuthorEntity, b: AuthorEntity) => number> = {
      count: (a, b) => b.count - a.count,
      latest: (a, b) =>
        new Date(b.latest_date || 0).getTime() -
        new Date(a.latest_date || 0).getTime(),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return filtered.sort(sorters[sort]);
  }, [items, q, sort]);

  const totalPages = Math.max(1, Math.ceil(authors.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleAuthors = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return authors.slice(start, start + pageSize);
  }, [authors, currentPage, pageSize]);
  const pageWindow = useMemo(
    () => getPageWindow(currentPage, totalPages),
    [currentPage, totalPages]
  );
  const startItem = authors.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, authors.length);

  useEffect(() => {
    if (page !== currentPage) {
      updateView({ page: currentPage });
    }
  }, [currentPage, page]);

  return (
    <section className="px-4 md:px-8 py-10">
      <div className="max-w-6xl mx-auto">
        <nav className="mb-6 flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wide">
          <a
            href={withBase("/")}
            className="rounded-full bg-surface-container-high px-3 py-1.5 text-on-surface-variant transition-colors hover:text-primary"
          >
            Buscar
          </a>
          <a
            href={buildCollectionHref("/authors", q, pageSize)}
            className="rounded-full bg-primary px-3 py-1.5 text-on-primary"
          >
            Autores
          </a>
          <a
            href={buildCollectionHref("/repos", q, pageSize)}
            className="rounded-full bg-surface-container-high px-3 py-1.5 text-on-surface-variant transition-colors hover:text-primary"
          >
            Repos
          </a>
        </nav>

        <header className="flex items-center justify-between mb-8 flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3 flex-wrap">
              <span className="material-symbols-outlined text-primary">group</span>
              Todos los autores
              <span className="text-sm font-normal text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full">
                {authors.length} / {items ? extractAllAuthors(items).size : 0}
              </span>
            </h2>
            <p className="text-on-surface-variant text-sm mt-1">
              {items
                ? `Derivado de ${items.length} marcadores (${total} en total en la base).`
                : "Cargando archivo..."}
            </p>
          </div>
          <div className="flex gap-3 items-center">
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">
                filter_alt
              </span>
              <input
                value={q}
                onChange={(e) => updateView({ q: e.target.value, page: 1 })}
                placeholder="Filtrar autores..."
                className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary pl-10 pr-4 py-2 rounded-lg text-on-surface text-sm w-64"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => updateView({ sort: e.target.value as SortKey, page: 1 })}
              className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary px-3 py-2 rounded-lg text-on-surface text-sm"
            >
              <option value="count">Mas marcadores</option>
              <option value="latest">Mas recientes</option>
              <option value="name">Alfabetico</option>
            </select>
            <select
              value={pageSize}
              onChange={(e) =>
                updateView({ pageSize: Number(e.target.value), page: 1 })
              }
              className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary px-3 py-2 rounded-lg text-on-surface text-sm"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size} por pagina
                </option>
              ))}
            </select>
          </div>
        </header>

        {err && (
          <div className="p-4 rounded-xl bg-error-container/30 border border-error/40 mb-4 text-sm text-error">
            {err}
          </div>
        )}

        {!items && !err && (
          <div className="text-center py-16 text-on-surface-variant">
            <span className="material-symbols-outlined text-4xl animate-pulse">
              hourglass_top
            </span>
            <p className="mt-3 text-sm">Cargando autores...</p>
          </div>
        )}

        {items && authors.length === 0 && !err && (
          <p className="text-sm text-on-surface-variant text-center py-16">
            Ningun autor coincide con "{q}".
          </p>
        )}

        {authors.length > 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 flex-wrap rounded-xl bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
            <p>
              Mostrando <span className="font-bold text-on-surface">{startItem}</span> a{" "}
              <span className="font-bold text-on-surface">{endItem}</span> de{" "}
              <span className="font-bold text-on-surface">{authors.length}</span> autores.
            </p>
            <p>
              Pagina <span className="font-bold text-on-surface">{currentPage}</span> de{" "}
              <span className="font-bold text-on-surface">{totalPages}</span>
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visibleAuthors.map((a) => (
            <a
              key={a.handle || a.name}
              href={withBase(
                `/?author=${encodeURIComponent(a.handle || a.name)}`
              )}
              className="group glass-card p-4 rounded-xl border border-outline-variant/15 hover:border-primary/40 transition-all flex items-start gap-3"
            >
              <div className="w-10 h-10 rounded-full bg-surface-container-highest flex items-center justify-center flex-shrink-0">
                <span className="text-sm font-bold text-primary">
                  {initials(a.name)}
                </span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-on-surface font-bold text-sm truncate group-hover:text-primary transition-colors">
                  {a.name}
                </p>
                {a.handle && (
                  <p className="text-on-surface-variant text-xs truncate">
                    @{a.handle}
                  </p>
                )}
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">
                    {a.count} marcador{a.count === 1 ? "" : "es"}
                  </span>
                  {a.latest_date && (
                    <span className="text-[10px] text-on-surface-variant">
                      ultimo {formatDate(a.latest_date)}
                    </span>
                  )}
                </div>
                {a.domains.size > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {[...a.domains].slice(0, 3).map((d) => (
                      <span
                        key={d}
                        className="text-[10px] text-on-surface-variant bg-surface-container-highest px-1.5 py-0.5 rounded"
                      >
                        {d}
                      </span>
                    ))}
                    {a.domains.size > 3 && (
                      <span className="text-[10px] text-on-surface-variant">
                        +{a.domains.size - 3}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </a>
          ))}
        </div>

        {authors.length > pageSize && (
          <nav
            aria-label="Paginacion de autores"
            className="mt-8 flex flex-wrap items-center justify-center gap-2"
          >
            <button
              type="button"
              onClick={() => updateView({ page: currentPage - 1 }, "push")}
              disabled={currentPage === 1}
              className="rounded-lg bg-surface-container-high px-3 py-2 text-sm text-on-surface transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:text-primary"
            >
              Anterior
            </button>
            {pageWindow.map((entry, index) =>
              entry === "ellipsis" ? (
                <span
                  key={`ellipsis-${index}`}
                  className="px-2 text-sm text-on-surface-variant"
                >
                  ...
                </span>
              ) : (
                <button
                  key={entry}
                  type="button"
                  onClick={() => updateView({ page: entry }, "push")}
                  className={`min-w-10 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    entry === currentPage
                      ? "bg-primary text-on-primary"
                      : "bg-surface-container-high text-on-surface hover:text-primary"
                  }`}
                >
                  {entry}
                </button>
              )
            )}
            <button
              type="button"
              onClick={() => updateView({ page: currentPage + 1 }, "push")}
              disabled={currentPage === totalPages}
              className="rounded-lg bg-surface-container-high px-3 py-2 text-sm text-on-surface transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:text-primary"
            >
              Siguiente
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}
