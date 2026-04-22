/**
 * RepoMentionsModal — opens from ReposList, shows the authors who mentioned
 * a given repo plus their heuristic profile (intent + sentiment + keywords
 * + snippet). Purely client-side, reuses the local corpus already loaded
 * by ReposList.
 */
import { useEffect, useMemo, useRef } from "react";
import type { SearchItem } from "../lib/api";
import { formatDate, initials } from "../lib/api";
import {
  analyzeRepoMentions,
  INTENT_LABELS,
  SENTIMENT_LABELS,
  type MentionIntent,
  type MentionSentiment,
  type RepoMention,
} from "../lib/repo-heuristics";

interface Props {
  slug: string;
  items: SearchItem[];
  onClose: () => void;
}

const INTENT_COLORS: Record<MentionIntent, string> = {
  build: "bg-primary text-on-primary border-primary",
  learn: "bg-secondary text-on-primary border-secondary",
  compare: "bg-tertiary text-on-primary border-tertiary",
  recommend: "bg-primary text-on-primary border-primary",
  ship: "bg-secondary text-on-primary border-secondary",
  critique: "bg-error text-on-primary border-error",
  discover: "bg-surface-container-highest text-on-surface border-outline-variant",
};

const SENTIMENT_COLORS: Record<MentionSentiment, string> = {
  positive: "text-primary border-primary",
  neutral: "text-on-surface-variant border-outline-variant",
  critical: "text-error border-error",
};

function buildTweetHref(item: SearchItem): string | null {
  if (item.source_url) return item.source_url;
  if (item.canonical_url) return item.canonical_url;
  if (item.tweet_id && item.author_username) {
    return `https://x.com/${item.author_username}/status/${item.tweet_id}`;
  }
  return null;
}

function summarizeByIntent(mentions: RepoMention[]) {
  const counts = new Map<MentionIntent, number>();
  for (const m of mentions) {
    counts.set(m.intent, (counts.get(m.intent) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function summarizeBySentiment(mentions: RepoMention[]) {
  const counts = new Map<MentionSentiment, number>();
  for (const m of mentions) {
    counts.set(m.sentiment, (counts.get(m.sentiment) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export default function RepoMentionsModal({ slug, items, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const mentions = useMemo(() => {
    const analyzed = analyzeRepoMentions(items, slug);
    // Sort: critiques first (surfacing counter-opinions), then by date desc.
    return analyzed.sort((a, b) => {
      const rank: Record<MentionSentiment, number> = {
        critical: 0,
        positive: 1,
        neutral: 2,
      };
      const diff = rank[a.sentiment] - rank[b.sentiment];
      if (diff !== 0) return diff;
      const aDate = a.item.created_at ? new Date(a.item.created_at).getTime() : 0;
      const bDate = b.item.created_at ? new Date(b.item.created_at).getTime() : 0;
      return bDate - aDate;
    });
  }, [items, slug]);

  const intentSummary = useMemo(() => summarizeByIntent(mentions), [mentions]);
  const sentimentSummary = useMemo(() => summarizeBySentiment(mentions), [mentions]);

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
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-widest text-on-surface-variant font-mono">
              $ mentions --repo
            </p>
            <h2 className="mt-1 text-lg md:text-xl font-bold text-on-surface font-mono truncate">
              {slug}
            </h2>
            <p className="mt-1 text-xs text-on-surface-variant font-mono">
              {mentions.length} {mentions.length === 1 ? "mencion" : "menciones"}
              {" "}&middot; analisis heuristico local
            </p>
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

        {mentions.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 px-5 py-4 border-b-2 border-outline-variant">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-on-surface-variant font-mono mb-2">
                &gt; intent.distribution
              </p>
              <div className="flex flex-wrap gap-1.5">
                {intentSummary.map(([intent, count]) => (
                  <span
                    key={intent}
                    className={`inline-flex items-center gap-1 border-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider font-mono ${INTENT_COLORS[intent]}`}
                  >
                    {INTENT_LABELS[intent]}
                    <span className="opacity-80">&times;{count}</span>
                  </span>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-on-surface-variant font-mono mb-2">
                &gt; sentiment.distribution
              </p>
              <div className="flex flex-wrap gap-1.5">
                {sentimentSummary.map(([sentiment, count]) => (
                  <span
                    key={sentiment}
                    className={`inline-flex items-center gap-1 border-2 bg-surface-container-highest px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider font-mono ${SENTIMENT_COLORS[sentiment]}`}
                  >
                    {SENTIMENT_LABELS[sentiment]}
                    <span className="opacity-80">&times;{count}</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4 space-y-3">
          {mentions.length === 0 && (
            <p className="text-sm text-on-surface-variant font-mono text-center py-8">
              No se encontraron menciones en el corpus cargado.
            </p>
          )}

          {mentions.map((mention, idx) => {
            const { item, intent, sentiment, keywords, snippet } = mention;
            const handle = item.author_username || "";
            const name = item.author_name || handle || "anonymous";
            const href = buildTweetHref(item);

            return (
              <article
                key={`${item.id || item.tweet_id || idx}`}
                className="terminal-card p-3 md:p-4"
              >
                <header className="flex items-center gap-3 mb-2">
                  <div className="flex h-9 w-9 items-center justify-center border-2 border-primary bg-surface-container-high text-xs font-bold text-primary font-mono shrink-0">
                    {initials(name)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-on-surface font-mono truncate">
                      {name}
                    </p>
                    <p className="text-[11px] text-on-surface-variant font-mono truncate">
                      {handle ? `@${handle}` : "—"}
                      {item.created_at ? ` · ${formatDate(item.created_at)}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span
                      className={`border-2 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider font-mono ${INTENT_COLORS[intent]}`}
                    >
                      {INTENT_LABELS[intent]}
                    </span>
                    <span
                      className={`border-2 bg-surface-container-highest px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider font-mono ${SENTIMENT_COLORS[sentiment]}`}
                    >
                      {SENTIMENT_LABELS[sentiment]}
                    </span>
                  </div>
                </header>

                {snippet && (
                  <p className="text-xs md:text-sm text-on-surface-variant mb-2 whitespace-pre-wrap break-words">
                    {snippet}
                  </p>
                )}

                {keywords.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {keywords.map((kw) => (
                      <span
                        key={kw}
                        className="border-2 border-outline-variant bg-surface-container-high px-1.5 py-0.5 text-[10px] text-on-surface-variant font-mono"
                      >
                        #{kw}
                      </span>
                    ))}
                  </div>
                )}

                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-secondary hover:text-primary font-mono"
                  >
                    -&gt; ver tweet original
                  </a>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
