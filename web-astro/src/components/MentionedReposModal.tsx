import { useEffect, useMemo, useRef } from "react";
import {
  extractGithubRepos,
  formatDate,
  getPrimarySourceUrl,
  initials,
  isGithubRepoUrl,
  type SearchItem,
} from "../lib/api";
import { withBase } from "../lib/url-state";

interface Props {
  item: SearchItem;
  onClose: () => void;
}

type MentionedRepo = {
  slug: string;
  owner: string;
  repo: string;
  count: number;
  hasReadme: boolean;
};

export default function MentionedReposModal({ item, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const displayName =
    item.author_name || item.author_username || item.user_id || "fuente";
  const primaryUrl = getPrimarySourceUrl(item);
  const primaryLabel = primaryUrl
    ? isGithubRepoUrl(primaryUrl)
      ? "Abrir repo"
      : "Abrir post"
    : "";

  const repos = useMemo<MentionedRepo[]>(() => {
    const readmeSlugs = new Set(
      (item.github_readmes || [])
        .map((readme) => String(readme.repo_slug || "").toLowerCase())
        .filter(Boolean)
    );

    return [...extractGithubRepos([item]).values()]
      .map((repo) => {
        const slug = `${repo.owner}/${repo.repo}`;
        return {
          slug,
          owner: repo.owner,
          repo: repo.repo,
          count: repo.count,
          hasReadme: readmeSlugs.has(slug.toLowerCase()),
        };
      })
      .sort(
        (a, b) =>
          b.count - a.count ||
          a.owner.localeCompare(b.owner) ||
          a.repo.localeCompare(b.repo)
      );
  }, [item]);

  const readmeCount = repos.filter((repo) => repo.hasReadme).length;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 backdrop-blur-sm p-4 md:p-8"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl terminal-panel neo-shadow-purple"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b-2 border-outline-variant px-5 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 items-center justify-center border-2 border-primary bg-surface-container-high text-sm font-bold text-primary font-mono shrink-0">
              {initials(displayName)}
            </div>
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-widest text-on-surface-variant font-mono">
                $ item.repos --all
              </p>
              <h2 className="mt-0.5 text-lg md:text-xl font-bold text-on-surface font-mono truncate">
                {repos.length} repo{repos.length === 1 ? "" : "s"} mencionados
              </h2>
              <p className="mt-0.5 text-xs text-on-surface-variant font-mono truncate">
                {displayName}
                {item.created_at ? ` | ${formatDate(item.created_at)}` : ""}
                {readmeCount > 0 ? ` | ${readmeCount} con README` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {primaryUrl && (
              <a
                href={primaryUrl}
                target="_blank"
                rel="noreferrer"
                className="border-2 border-primary bg-primary px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-on-primary hover:bg-secondary hover:border-secondary transition-colors font-mono"
              >
                {primaryLabel}
              </a>
            )}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Cerrar"
              className="border-2 border-outline-variant bg-surface-container-highest px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-on-surface hover:border-primary hover:text-primary transition-colors font-mono"
            >
              [esc] cerrar
            </button>
          </div>
        </header>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-2">
          {repos.length === 0 && (
            <p className="text-sm text-on-surface-variant font-mono text-center py-8">
              Este post no tiene repos detectados.
            </p>
          )}

          {repos.map((repo) => (
            <article
              key={repo.slug}
              className="terminal-card flex items-start gap-3 p-3"
            >
              <span className="material-symbols-outlined text-primary text-lg flex-shrink-0 mt-0.5">
                code
              </span>
              <div className="min-w-0 flex-1">
                <a
                  href={`https://github.com/${repo.owner}/${repo.repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-on-surface font-bold text-sm truncate hover:text-primary transition-colors font-mono"
                >
                  {repo.owner}/<span className="text-primary">{repo.repo}</span>
                </a>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {repo.count > 1 && (
                    <span className="border-2 border-primary bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary font-mono">
                      {repo.count}x
                    </span>
                  )}
                  <a
                    href={`https://github.com/${repo.owner}/${repo.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 border-2 border-primary bg-surface-container-low px-2 py-0.5 text-[11px] font-bold text-primary hover:bg-primary hover:text-on-primary transition-colors"
                  >
                    Abrir repo
                  </a>
                  {repo.hasReadme ? (
                    <a
                      href={withBase(`/readmes?repo=${encodeURIComponent(repo.slug)}`)}
                      className="inline-flex items-center gap-1 border-2 border-secondary bg-surface-container-low px-2 py-0.5 text-[11px] font-bold text-secondary hover:bg-secondary hover:text-on-primary transition-colors"
                    >
                      README
                    </a>
                  ) : (
                    <span className="border border-outline-variant bg-surface-container-highest px-2 py-0.5 text-[10px] text-on-surface-variant font-mono">
                      sin README cacheado
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
