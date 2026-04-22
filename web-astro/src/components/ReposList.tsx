/**
 * ReposList — dedicated view for every GitHub repo referenced in the corpus.
 * Aligns with featureGoal.md §7 (knowledge_assets of type=repo) and §11 (graph).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  extractGithubRepos,
  extractUsers,
  fetchUsers,
  formatDate,
  getCorpus,
  type SearchItem,
  type RepoEntity,
  type UserSummary,
} from "../lib/api";
import { withBase } from "../lib/url-state";
import RepoMentionsModal from "./RepoMentionsModal";

type SortKey = "count" | "latest" | "owner" | "repo";
type HistoryMode = "replace" | "push";

interface ViewState {
  user: string;
  q: string;
  sort: SortKey;
  page: number;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 24;
const PAGE_SIZE_OPTIONS = [24, 48, 96];
const VALID_SORTS = new Set<SortKey>(["count", "latest", "owner", "repo"]);

function clampPositiveInt(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeState(state: ViewState): ViewState {
  return {
    user: state.user,
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
      user: "",
      sort: "count",
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
    };
  }

  const params = new URLSearchParams(window.location.search);
  const rawSort = (params.get("sort") || "count") as SortKey;

  return normalizeState({
    user: params.get("user") || "",
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

  if (next.user) params.set("user", next.user);
  else params.delete("user");

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

function buildCollectionHref(
  path: "/authors" | "/repos",
  user: string,
  q: string,
  pageSize: number
) {
  const params = new URLSearchParams();
  if (user.trim()) params.set("user", user.trim());
  if (q.trim()) params.set("q", q.trim());
  if (pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(pageSize));
  return withBase(`${path}${params.toString() ? `?${params.toString()}` : ""}`);
}

function buildSearchHref(values: Record<string, string>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return withBase(`/${params.toString() ? `?${params.toString()}` : ""}`);
}

export default function ReposList() {
  const [items, setItems] = useState<SearchItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [view, setView] = useState<ViewState>(() => readViewState());
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);

  const { user, q, sort, page, pageSize } = view;

  useEffect(() => {
    setItems(null);
    setErr(null);
    getCorpus(false, user)
      .then((c) => {
        setItems(c.items);
        setTotal(c.total);
      })
      .catch((e) => setErr(e?.message || String(e)));
  }, [user]);

  useEffect(() => {
    let mounted = true;
    fetchUsers()
      .then((items) => {
        if (!mounted) return;
        setUsers(items);
      })
      .catch(() => {
        if (!mounted) return;
        setUsers([]);
      });
    return () => {
      mounted = false;
    };
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

  const repos = useMemo<RepoEntity[]>(() => {
    if (!items) return [];
    const list = [...extractGithubRepos(items).values()];
    const ql = q.trim().toLowerCase();
    const filtered = ql
      ? list.filter(
          (r) =>
            r.owner.toLowerCase().includes(ql) ||
            r.repo.toLowerCase().includes(ql) ||
            (r.sample_author || "").toLowerCase().includes(ql)
        )
      : list;
    const sorters: Record<SortKey, (a: RepoEntity, b: RepoEntity) => number> = {
      count: (a, b) => b.count - a.count,
      latest: (a, b) =>
        new Date(b.latest_date || 0).getTime() -
        new Date(a.latest_date || 0).getTime(),
      owner: (a, b) => a.owner.localeCompare(b.owner),
      repo: (a, b) => a.repo.localeCompare(b.repo),
    };
    return filtered.sort(sorters[sort]);
  }, [items, q, sort]);
  const availableUsers = useMemo(
    () => (users.length > 0 ? users : extractUsers(items || [])),
    [items, users]
  );

  const totalPages = Math.max(1, Math.ceil(repos.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleRepos = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return repos.slice(start, start + pageSize);
  }, [currentPage, pageSize, repos]);
  const pageWindow = useMemo(
    () => getPageWindow(currentPage, totalPages),
    [currentPage, totalPages]
  );
  const startItem = repos.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, repos.length);

  function goToPage(nextPage: number) {
    const safePage = Math.max(1, Math.min(totalPages, nextPage));
    if (safePage === currentPage) return;
    updateView({ page: safePage }, "push");
    window.requestAnimationFrame(() => {
      topRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  useEffect(() => {
    if (page !== currentPage) {
      updateView({ page: currentPage });
    }
  }, [currentPage, page]);

  return (
    <section className="px-4 md:px-8 py-10 pb-24 md:pb-10">
      <div ref={topRef} className="max-w-6xl mx-auto">
        <nav className="mb-6 flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-wide">
          <a
            href={buildSearchHref({ user })}
            className="rounded-full bg-surface-container-high px-3 py-1.5 text-on-surface-variant transition-colors hover:text-primary"
          >
            Buscar
          </a>
          <a
            href={buildCollectionHref("/authors", user, q, pageSize)}
            className="rounded-full bg-surface-container-high px-3 py-1.5 text-on-surface-variant transition-colors hover:text-primary"
          >
            Autores
          </a>
          <a
            href={buildCollectionHref("/repos", user, q, pageSize)}
            className="rounded-full bg-primary px-3 py-1.5 text-on-primary"
          >
            Repos
          </a>
        </nav>

        <header className="flex items-center justify-between mb-8 flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-headline font-bold text-on-surface flex items-center gap-3 flex-wrap">
              <span className="material-symbols-outlined text-primary">hub</span>
              Repositorios de GitHub
              <span className="text-sm font-normal text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full">
                {repos.length} / {items ? extractGithubRepos(items).size : 0}
              </span>
            </h2>
            <p className="text-on-surface-variant text-sm mt-1">
              {items
                ? `Se analizaron URLs, enlaces y texto en ${items.length} marcadores (${total} en total).`
                : "Cargando archivo..."}
            </p>
          </div>
          <div className="flex gap-3 items-center">
            <select
              value={user}
              onChange={(e) => updateView({ user: e.target.value, page: 1 })}
              className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary px-3 py-2 rounded-lg text-on-surface text-sm"
            >
              <option value="">Todos los usuarios</option>
              {availableUsers.map((entry) => (
                <option key={entry.user_id} value={entry.user_id}>
                  {entry.user_id} ({entry.count})
                </option>
              ))}
            </select>
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">
                filter_alt
              </span>
              <input
                value={q}
                onChange={(e) => updateView({ q: e.target.value, page: 1 })}
                placeholder="Filtrar repos..."
                className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary pl-10 pr-4 py-2 rounded-lg text-on-surface text-sm w-64"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => updateView({ sort: e.target.value as SortKey, page: 1 })}
              className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary px-3 py-2 rounded-lg text-on-surface text-sm"
            >
              <option value="count">Mas referenciados</option>
              <option value="latest">Mas recientes</option>
              <option value="owner">Owner A-Z</option>
              <option value="repo">Repo A-Z</option>
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
            <p className="mt-3 text-sm">Buscando referencias de GitHub...</p>
          </div>
        )}

        {items && repos.length === 0 && !err && (
          <p className="text-sm text-on-surface-variant text-center py-16">
            Ningun repositorio coincide con "{q}".
          </p>
        )}

        {repos.length > 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 flex-wrap rounded-xl bg-surface-container-low px-4 py-3 text-sm text-on-surface-variant">
            <p>
              Mostrando <span className="font-bold text-on-surface">{startItem}</span> a{" "}
              <span className="font-bold text-on-surface">{endItem}</span> de{" "}
              <span className="font-bold text-on-surface">{repos.length}</span> repos.
            </p>
            <p>
              Pagina <span className="font-bold text-on-surface">{currentPage}</span> de{" "}
              <span className="font-bold text-on-surface">{totalPages}</span>
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visibleRepos.map((r) => (
            <div
              key={`${r.owner}/${r.repo}`}
              className="glass-card p-4 rounded-xl border border-outline-variant/15 hover:border-primary/40 transition-all flex items-start gap-3"
            >
              <span className="material-symbols-outlined text-primary text-lg flex-shrink-0 mt-0.5">
                code
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={`https://github.com/${r.owner}/${r.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-on-surface font-bold text-sm truncate hover:text-primary transition-colors"
                >
                  {r.repo}
                </a>
                <p className="text-on-surface-variant text-xs truncate">
                  {r.owner}
                </p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="text-[10px] font-bold text-primary bg-primary/10 px-2 py-0.5 rounded">
                    {r.count}x referenciado
                  </span>
                  {r.latest_date && (
                    <span className="text-[10px] text-on-surface-variant">
                      {formatDate(r.latest_date)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  {r.sample_author && (
                    <a
                      href={buildSearchHref({
                        user,
                        author: r.sample_author,
                      })}
                      className="text-[10px] text-secondary bg-secondary/10 px-2 py-0.5 rounded hover:bg-secondary/20"
                    >
                      por {r.sample_author}
                    </a>
                  )}
                  <a
                    href={buildSearchHref({
                      user,
                      q: `${r.owner}/${r.repo}`,
                    })}
                    className="text-[10px] text-on-surface-variant bg-surface-container-highest px-2 py-0.5 rounded hover:text-primary"
                  >
                    Buscar en marcadores
                  </a>
                  <button
                    type="button"
                    onClick={() => setSelectedSlug(`${r.owner}/${r.repo}`)}
                    className="text-[10px] text-primary border-2 border-primary bg-primary/10 px-2 py-0.5 hover:bg-primary hover:text-on-primary transition-colors font-mono"
                  >
                    &gt; ver menciones
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {selectedSlug && items && (
          <RepoMentionsModal
            slug={selectedSlug}
            items={items}
            onClose={() => setSelectedSlug(null)}
          />
        )}

        {repos.length > pageSize && (
          <div className="mt-8 overflow-x-auto pb-2 no-scrollbar">
            <nav
              aria-label="Paginacion de repositorios"
              className="flex w-max min-w-full items-center justify-center gap-2"
            >
              <button
                type="button"
                onClick={() => goToPage(currentPage - 1)}
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
                    onClick={() => goToPage(entry)}
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
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage === totalPages}
                className="rounded-lg bg-surface-container-high px-3 py-2 text-sm text-on-surface transition-colors disabled:cursor-not-allowed disabled:opacity-40 hover:text-primary"
              >
                Siguiente
              </button>
            </nav>
          </div>
        )}
      </div>
    </section>
  );
}
