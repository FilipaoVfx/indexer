/**
 * ReposList — dedicated view for every GitHub repo referenced in the corpus.
 * Aligns with featureGoal.md §7 (knowledge_assets of type=repo) and §11 (graph).
 */
import { useEffect, useMemo, useState } from "react";
import {
  extractGithubRepos,
  formatDate,
  getCorpus,
  type SearchItem,
  type RepoEntity,
} from "../lib/api";
import { withBase } from "../lib/url-state";

type SortKey = "count" | "latest" | "owner" | "repo";

export default function ReposList() {
  const [items, setItems] = useState<SearchItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("count");

  useEffect(() => {
    getCorpus()
      .then((c) => {
        setItems(c.items);
        setTotal(c.total);
      })
      .catch((e) => setErr(e?.message || String(e)));
  }, []);

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

  return (
    <section className="px-4 md:px-8 py-10">
      <div className="max-w-6xl mx-auto">
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
            <div className="relative">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">
                filter_alt
              </span>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filtrar repos..."
                className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary pl-10 pr-4 py-2 rounded-lg text-on-surface text-sm w-64"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary px-3 py-2 rounded-lg text-on-surface text-sm"
            >
              <option value="count">Mas referenciados</option>
              <option value="latest">Mas recientes</option>
              <option value="owner">Owner A-Z</option>
              <option value="repo">Repo A-Z</option>
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

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {repos.map((r) => (
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
                      href={withBase(
                        `/?author=${encodeURIComponent(r.sample_author)}`
                      )}
                      className="text-[10px] text-secondary bg-secondary/10 px-2 py-0.5 rounded hover:bg-secondary/20"
                    >
                      por {r.sample_author}
                    </a>
                  )}
                  <a
                    href={withBase(
                      `/?q=${encodeURIComponent(`${r.owner}/${r.repo}`)}`
                    )}
                    className="text-[10px] text-on-surface-variant bg-surface-container-highest px-2 py-0.5 rounded hover:text-primary"
                  >
                    Buscar en marcadores
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
