/**
 * AuthorReposModal — shows the GitHub repos an author has mentioned.
 * Sibling of RepoMentionsModal (which goes the other direction). Pure
 * client-side, operates on the corpus already cached by AuthorsList.
 */
import { useEffect, useMemo, useRef } from "react";
import { formatDate, initials } from "../lib/api";
import type { AuthorRepoEntry } from "../lib/repo-heuristics";

interface Props {
  entry: AuthorRepoEntry;
  onClose: () => void;
}

type SortedRepo = {
  slug: string;
  owner: string;
  repo: string;
  count: number;
  latest_date: string | null;
};

export default function AuthorReposModal({ entry, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const repos = useMemo<SortedRepo[]>(() => {
    return [...entry.repos.values()]
      .map((r) => {
        const [owner, repo] = r.slug.split("/");
        return {
          slug: r.slug,
          owner,
          repo,
          count: r.count,
          latest_date: r.latest_date,
        };
      })
      .sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        const bDate = b.latest_date ? new Date(b.latest_date).getTime() : 0;
        const aDate = a.latest_date ? new Date(a.latest_date).getTime() : 0;
        return bDate - aDate;
      });
  }, [entry]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const displayName = entry.name || entry.handle || "anonymous";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 md:p-8"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl terminal-panel neo-shadow-purple"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b-2 border-outline-variant px-5 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 items-center justify-center border-2 border-primary bg-surface-container-high text-sm font-bold text-primary font-mono shrink-0">
              {initials(displayName)}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-widest text-on-surface-variant font-mono">
                $ author.repos --list
              </p>
              <h2 className="mt-0.5 text-lg md:text-xl font-bold text-on-surface font-mono truncate">
                {displayName}
              </h2>
              <p className="mt-0.5 text-xs text-on-surface-variant font-mono truncate">
                {entry.handle ? `@${entry.handle}` : "—"}
                {" "}&middot; {entry.repos.size} repo{entry.repos.size === 1 ? "" : "s"}
                {" "}&middot; {entry.totalMentions} mencion{entry.totalMentions === 1 ? "" : "es"}
              </p>
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="shrink-0 border-2 border-outline-variant bg-surface-container-highest px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-on-surface hover:border-primary hover:text-primary transition-colors font-mono"
          >
            [esc] cerrar
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-2">
          {repos.length === 0 && (
            <p className="text-sm text-on-surface-variant font-mono text-center py-8">
              Sin repos detectados para este autor.
            </p>
          )}

          {repos.map((r) => (
            <article
              key={r.slug}
              className="terminal-card flex items-start gap-3 p-3"
            >
              <span className="material-symbols-outlined text-primary text-lg flex-shrink-0 mt-0.5">
                code
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={`https://github.com/${r.owner}/${r.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-on-surface font-bold text-sm truncate hover:text-primary transition-colors font-mono"
                >
                  {r.owner}/<span className="text-primary">{r.repo}</span>
                </a>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="border-2 border-primary bg-primary/10 text-primary px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider font-mono">
                    {r.count}x
                  </span>
                  {r.latest_date && (
                    <span className="text-[10px] text-on-surface-variant font-mono">
                      ultimo {formatDate(r.latest_date)}
                    </span>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
