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

export default function AuthorsList() {
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

  return (
    <section className="px-4 md:px-8 py-10">
      <div className="max-w-6xl mx-auto">
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
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filtrar autores..."
                className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary pl-10 pr-4 py-2 rounded-lg text-on-surface text-sm w-64"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SortKey)}
              className="bg-surface-container-lowest border-none focus:ring-2 focus:ring-primary px-3 py-2 rounded-lg text-on-surface text-sm"
            >
              <option value="count">Mas marcadores</option>
              <option value="latest">Mas recientes</option>
              <option value="name">Alfabetico</option>
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

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {authors.map((a) => (
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
      </div>
    </section>
  );
}
